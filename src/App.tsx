import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl";
import {
  analyzeTrees,
  emptyAnalysis,
  getBoundsFromCluster,
  getBoundsFromTrees,
  getClusterCenter,
} from "./lib/analysis";
import { decodeCsvBuffer, parseTreeCsv } from "./lib/csv";
import type { AnalysisResult, ClusterModel, Controls, TreeRecord } from "./types";

const DEFAULT_CONTROLS: Controls = {
  distance: 10,
  minClusterSize: 5,
  geometryMode: "concave",
  highlightMetric: "hybrid",
  highlightCount: 5,
  district: "ALL",
  viewMode: "all",
};

type StatusTone = "info" | "success" | "warning";
type PanelTab = "controls" | "summary" | "highlights";

export default function App() {
  const [trees, setTrees] = useState<TreeRecord[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult>(emptyAnalysis(DEFAULT_CONTROLS));
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>("controls");
  const [statusMessage, setStatusMessage] = useState("같은 폴더의 seoul_cb_tree.csv를 자동으로 읽고 있습니다.");
  const [statusTone, setStatusTone] = useState<StatusTone>("info");
  const [fitRequestToken, setFitRequestToken] = useState(0);

  const deferredControls = useDeferredValue(controls);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const sourcesReadyRef = useRef(false);
  const analysisRef = useRef<AnalysisResult>(analysis);

  const districts = Array.from(new Set(trees.map((tree) => tree.district))).sort((a, b) =>
    a.localeCompare(b, "ko"),
  );

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [126.978, 37.5665],
      zoom: 11.2,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      addSourcesAndLayers(map);
      bindMapInteractions(map, popupRef);
      sourcesReadyRef.current = true;
      renderAnalysisOnMap(map, analysisRef.current);
      fitAnalysisBounds(map, analysisRef.current);
    });

    mapRef.current = map;

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      sourcesReadyRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCsv() {
      setStatusMessage("같은 폴더의 seoul_cb_tree.csv를 자동으로 읽고 있습니다.");
      setStatusTone("info");

      try {
        const csvUrl = new URL(`${import.meta.env.BASE_URL}seoul_cb_tree.csv`, window.location.href);
        const response = await fetch(csvUrl, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const nextTrees = parseTreeCsv(decodeCsvBuffer(buffer));
        if (cancelled) return;

        setTrees(nextTrees);
        setStatusMessage(`seoul_cb_tree.csv에서 ${formatInteger(nextTrees.length)}개의 벚나무 좌표를 불러왔습니다.`);
        setStatusTone("success");
        setFitRequestToken((value) => value + 1);
      } catch {
        if (cancelled) return;
        setStatusMessage("seoul_cb_tree.csv 자동 로드에 실패했습니다. 같은 디렉토리에서 HTTP로 서빙되는지 확인해 주세요.");
        setStatusTone("warning");
      }
    }

    loadCsv();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!trees.length) {
      setAnalysis(emptyAnalysis(deferredControls));
      return;
    }

    const nextAnalysis = analyzeTrees(trees, deferredControls);
    startTransition(() => {
      setAnalysis(nextAnalysis);
    });

    if (!nextAnalysis.visibleTrees.length) {
      setStatusMessage("선택한 자치구에는 표시할 데이터가 없습니다.");
      setStatusTone("warning");
      return;
    }

    if (nextAnalysis.displayedClusters.length > 0) {
      setStatusMessage(
        `${formatInteger(nextAnalysis.visibleTrees.length)}개 나무를 분석했고 ${formatInteger(nextAnalysis.displayedClusters.length)}개 군집과 ${formatInteger(nextAnalysis.highlights.length)}개 추천 구간을 계산했습니다.`,
      );
      setStatusTone("success");
      return;
    }

    setStatusMessage(
      `${formatInteger(nextAnalysis.visibleTrees.length)}개 나무를 분석했습니다. 현재 조건에서는 군집 영역이 없어 포인트만 표시합니다.`,
    );
    setStatusTone("info");
  }, [trees, deferredControls]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;
    renderAnalysisOnMap(map, analysis);
  }, [analysis]);

  useEffect(() => {
    if (fitRequestToken === 0) return;
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;
    fitAnalysisBounds(map, analysis);
  }, [analysis, fitRequestToken]);

  function updateControl<K extends keyof Controls>(key: K, value: Controls[K], fit = false) {
    startTransition(() => {
      setControls((current) => ({ ...current, [key]: value }));
    });

    if (fit) {
      setFitRequestToken((current) => current + 1);
    }
  }

  function resetControls() {
    startTransition(() => {
      setControls(DEFAULT_CONTROLS);
    });
    setFitRequestToken((current) => current + 1);
  }

  function moveToHighlight(cluster: ClusterModel) {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;

    map.fitBounds(getBoundsFromCluster(cluster), {
      padding: 90,
      duration: 900,
      maxZoom: 16,
    });

    const center = getClusterCenter(cluster);
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(center)
      .setHTML(renderClusterPopup(cluster))
      .addTo(map);
  }

  const activeDistrictLabel = controls.district === "ALL" ? "전체" : controls.district;
  const largestCluster = analysis.displayedClusters.length
    ? Math.max(...analysis.displayedClusters.map((cluster) => cluster.size))
    : 0;
  const averageCluster = analysis.displayedClusters.length
    ? analysis.displayedClusters.reduce((sum, cluster) => sum + cluster.size, 0) /
      analysis.displayedClusters.length
    : 0;
  const chips = [
    `거리 ${controls.distance}m`,
    `최소 ${controls.minClusterSize}개`,
    `영역 ${geometryLabel(controls.geometryMode)}`,
    `모드 ${viewModeLabel(controls.viewMode)}`,
    controls.district === "ALL" ? "전체 자치구" : controls.district,
  ];

  return (
    <div className="shell">
      <aside className="panel">
        <section className="hero card">
          <p className="eyebrow">Seoul Cherry Blossom Road Explorer</p>
          <h1>서울 벚꽃길 군집 분석</h1>
          <p className="hero-copy">
            README의 요구사항에 맞춰 CSV 자동 로드, 거리 기반 군집화, 군집 영역 생성,
            추천 벚꽃길 탐색까지 React 환경에서 다시 구성했습니다.
          </p>
        </section>

        <section className="card">
          <div className="section-head">
            <h2>데이터</h2>
          </div>
          <div className="status-box">
            <span className={`status-dot is-${statusTone}`}></span>
            <p>{statusMessage}</p>
          </div>
          <p className="helper">
            데이터는 <code>public/seoul_cb_tree.csv</code>에서 자동으로 로드되며 빌드 후
            정적 배포에도 그대로 포함됩니다.
          </p>
        </section>

        <section className="card tab-shell">
          <div className="tab-list" role="tablist" aria-label="왼쪽 패널 탭">
            {[
              { key: "controls", label: "분석조건" },
              { key: "summary", label: "요약" },
              { key: "highlights", label: "추천 벚꽃길" },
            ].map((tab) => (
              <button
                key={tab.key}
                className={`tab-button${activePanelTab === tab.key ? " is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activePanelTab === tab.key}
                onClick={() => setActivePanelTab(tab.key as PanelTab)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="tab-body">
            {activePanelTab === "controls" && (
              <div className="tab-panel">
                <div className="section-head">
                  <h2>분석 조건</h2>
                </div>

                <label className="field">
                  <div className="field-row">
                    <span className="field-label">거리 임계값</span>
                    <strong>{controls.distance}m</strong>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="1"
                    value={controls.distance}
                    onChange={(event) =>
                      updateControl("distance", clamp(Number(event.target.value), 5, 30))
                    }
                  />
                  <div className="range-legend">
                    <span>5m</span>
                    <span>Connected Components</span>
                    <span>30m</span>
                  </div>
                </label>

                <div className="grid two">
                  <label className="field">
                    <span className="field-label">최소 나무 수</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={controls.minClusterSize}
                      onChange={(event) =>
                        updateControl("minClusterSize", Math.max(1, Number(event.target.value) || 1))
                      }
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">구 필터</span>
                    <select
                      value={controls.district}
                      onChange={(event) => updateControl("district", event.target.value, true)}
                    >
                      <option value="ALL">전체</option>
                      {districts.map((district) => (
                        <option key={district} value={district}>
                          {district}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="grid two">
                  <label className="field">
                    <span className="field-label">영역 생성 방식</span>
                    <select
                      value={controls.geometryMode}
                      onChange={(event) =>
                        updateControl("geometryMode", event.target.value as Controls["geometryMode"])
                      }
                    >
                      <option value="concave">Concave Hull</option>
                      <option value="convex">Convex Hull</option>
                      <option value="buffer">Buffer + Dissolve</option>
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">강조 기준</span>
                    <select
                      value={controls.highlightMetric}
                      onChange={(event) =>
                        updateControl("highlightMetric", event.target.value as Controls["highlightMetric"])
                      }
                    >
                      <option value="hybrid">추천도</option>
                      <option value="size">군집 크기</option>
                      <option value="density">밀도</option>
                    </select>
                  </label>
                </div>

                <div className="grid two">
                  <label className="field">
                    <span className="field-label">강조 개수</span>
                    <input
                      type="number"
                      min="1"
                      max="12"
                      step="1"
                      value={controls.highlightCount}
                      onChange={(event) =>
                        updateControl("highlightCount", clamp(Number(event.target.value) || 1, 1, 12))
                      }
                    />
                  </label>

                  <div className="field">
                    <span className="field-label">시각화 모드</span>
                    <div className="segmented">
                      {[
                        { value: "all", label: "전체" },
                        { value: "points", label: "포인트" },
                        { value: "areas", label: "군집 영역" },
                        { value: "highlights", label: "강조 구간" },
                      ].map((option) => (
                        <label key={option.value} className="seg-pill">
                          <input
                            type="radio"
                            name="viewMode"
                            value={option.value}
                            checked={controls.viewMode === option.value}
                            onChange={() =>
                              updateControl("viewMode", option.value as Controls["viewMode"])
                            }
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <button className="primary-button" type="button" onClick={resetControls}>
                  기본 설정으로 되돌리기
                </button>
              </div>
            )}

            {activePanelTab === "summary" && (
              <div className="tab-panel">
                <div className="section-head">
                  <h2>요약</h2>
                </div>
                <div className="stats-grid">
                  <article className="stat">
                    <span className="stat-label">표시 나무</span>
                    <strong>{formatInteger(analysis.visibleTrees.length)}</strong>
                  </article>
                  <article className="stat">
                    <span className="stat-label">표시 군집</span>
                    <strong>{formatInteger(analysis.displayedClusters.length)}</strong>
                  </article>
                  <article className="stat">
                    <span className="stat-label">강조 구간</span>
                    <strong>{formatInteger(analysis.highlights.length)}</strong>
                  </article>
                  <article className="stat">
                    <span className="stat-label">최대 군집 크기</span>
                    <strong>{formatInteger(largestCluster)}</strong>
                  </article>
                  <article className="stat">
                    <span className="stat-label">평균 군집 크기</span>
                    <strong>{averageCluster.toFixed(1)}</strong>
                  </article>
                  <article className="stat">
                    <span className="stat-label">현재 범위</span>
                    <strong>{activeDistrictLabel}</strong>
                  </article>
                </div>
              </div>
            )}

            {activePanelTab === "highlights" && (
              <div className="tab-panel">
                <div className="section-head">
                  <h2>추천 벚꽃길</h2>
                  <span className="badge">{analysis.highlights.length}</span>
                </div>
                <ol className="highlight-list">
                  {analysis.highlights.length === 0 ? (
                    <li className="empty-state">현재 조건에서는 강조할 구간이 없습니다.</li>
                  ) : (
                    analysis.highlights.map((cluster) => (
                      <li key={cluster.clusterId} className="highlight-item">
                        <button
                          className="highlight-button"
                          type="button"
                          onClick={() => moveToHighlight(cluster)}
                        >
                          <div className="highlight-row">
                            <div>
                              <p className="highlight-title">
                                {cluster.district} · {cluster.species}
                              </p>
                              <p className="highlight-meta">
                                나무 {formatInteger(cluster.size)}개 · 면적 {formatArea(cluster.areaM2)} ·
                                범위 {formatMeters(cluster.spanMeters)}
                              </p>
                              <p className="highlight-score">추천 점수 {cluster.score.toFixed(1)}</p>
                            </div>
                            <span className="rank-pill">{cluster.rank}</span>
                          </div>
                        </button>
                      </li>
                    ))
                  )}
                </ol>
              </div>
            )}
          </div>
        </section>
      </aside>

      <main className="map-shell">
        <div className="map-meta">
          <div>
            <p className="map-kicker">Interactive Map</p>
            <h2>거리 기반 군집, 영역, 추천 벚꽃길</h2>
          </div>
          <div className="chip-row">
            {chips.map((chip) => (
              <span key={chip} className="chip">
                {chip}
              </span>
            ))}
          </div>
        </div>
        <div ref={mapContainerRef} id="map" aria-label="서울 벚나무 분석 지도"></div>
      </main>
    </div>
  );
}

function addSourcesAndLayers(map: maplibregl.Map) {
  map.addSource("trees", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).pointFeatures });
  map.addSource("clusters", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).clusterFeatures });
  map.addSource("highlights", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).highlightFeatures });
  map.addSource("highlight-centers", {
    type: "geojson",
    data: emptyAnalysis(DEFAULT_CONTROLS).highlightCenters,
  });

  map.addLayer({
    id: "clusters-fill",
    type: "fill",
    source: "clusters",
    paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.18 },
  });
  map.addLayer({
    id: "clusters-outline",
    type: "line",
    source: "clusters",
    paint: { "line-color": ["get", "lineColor"], "line-width": 1.6, "line-opacity": 0.72 },
  });
  map.addLayer({
    id: "highlights-fill",
    type: "fill",
    source: "highlights",
    paint: { "fill-color": "#ff6f91", "fill-opacity": 0.26 },
  });
  map.addLayer({
    id: "highlights-outline",
    type: "line",
    source: "highlights",
    paint: { "line-color": "#f04474", "line-width": 3, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "highlight-centers",
    type: "circle",
    source: "highlight-centers",
    paint: {
      "circle-radius": 5.8,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#f04474",
      "circle-stroke-width": 2.3,
    },
  });
  map.addLayer({
    id: "trees-points",
    type: "circle",
    source: "trees",
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "clusterSize"], 1],
        1,
        3.2,
        10,
        5.2,
        40,
        8.5,
      ],
      "circle-color": ["coalesce", ["get", "pointColor"], "#3f7be0"],
      "circle-opacity": ["coalesce", ["get", "pointOpacity"], 0.92],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.05,
    },
  });
}

function bindMapInteractions(
  map: maplibregl.Map,
  popupRef: MutableRefObject<maplibregl.Popup | null>,
) {
  ["trees-points", "clusters-fill", "highlights-fill"].forEach((layerId) => {
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  });

  map.on("click", "trees-points", (event) => {
    const feature = event.features?.[0] as MapGeoJSONFeature | undefined;
    if (!feature) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(event.lngLat)
      .setHTML(renderPointPopup(feature))
      .addTo(map);
  });

  const clusterHandler = (event: maplibregl.MapLayerMouseEvent) => {
    const feature = event.features?.[0] as MapGeoJSONFeature | undefined;
    if (!feature) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(event.lngLat)
      .setHTML(renderFeatureClusterPopup(feature))
      .addTo(map);
  };

  map.on("click", "clusters-fill", clusterHandler);
  map.on("click", "highlights-fill", clusterHandler);
}

function renderAnalysisOnMap(map: maplibregl.Map, analysis: AnalysisResult) {
  setSourceData(map, "trees", analysis.pointFeatures);
  setSourceData(map, "clusters", analysis.clusterFeatures);
  setSourceData(map, "highlights", analysis.highlightFeatures);
  setSourceData(map, "highlight-centers", analysis.highlightCenters);
}

function setSourceData(map: maplibregl.Map, sourceId: string, data: GeoJSON.GeoJSON) {
  const source = map.getSource(sourceId);
  if (source && "setData" in source) {
    (source as GeoJSONSource).setData(data);
  }
}

function fitAnalysisBounds(map: maplibregl.Map, analysis: AnalysisResult) {
  const bounds = getBoundsFromTrees(analysis.visibleTrees);
  if (!bounds) return;
  map.fitBounds(bounds, {
    padding: 64,
    duration: 800,
    maxZoom: 15.2,
  });
}

function renderPointPopup(feature: MapGeoJSONFeature): string {
  const properties = feature.properties as Record<string, string | number>;
  const lines = [
    `자치구: ${escapeHtml(String(properties.district ?? "미상"))}`,
    `수종: ${escapeHtml(String(properties.species ?? "벚나무"))}`,
    `군집 크기: ${formatInteger(Number(properties.clusterSize ?? 1))}개`,
  ];

  if (properties.height) lines.push(`수고: ${escapeHtml(String(properties.height))}m`);
  if (properties.trunk) lines.push(`흉고직경: ${escapeHtml(String(properties.trunk))}cm`);
  if (properties.canopy) lines.push(`수관폭: ${escapeHtml(String(properties.canopy))}m`);
  if (properties.planted) lines.push(`식재일: ${escapeHtml(String(properties.planted))}`);

  return `<p class="popup-title">${escapeHtml(String(properties.species ?? "벚나무 포인트"))}</p><p class="popup-body">${lines.join("<br />")}</p>`;
}

function renderFeatureClusterPopup(feature: MapGeoJSONFeature): string {
  const properties = feature.properties as Record<string, string | number>;
  const lines = [
    `나무 수: ${formatInteger(Number(properties.size ?? 0))}개`,
    `주요 자치구: ${escapeHtml(String(properties.district ?? "미상"))}`,
    `주요 수종: ${escapeHtml(String(properties.species ?? "벚나무"))}`,
    `추정 면적: ${formatArea(Number(properties.areaM2 ?? 0))}`,
    `추천 점수: ${Number(properties.score ?? 0).toFixed(1)}`,
  ];

  return `<p class="popup-title">군집 ${escapeHtml(String(properties.clusterId ?? "-"))}</p><p class="popup-body">${lines.join("<br />")}</p>`;
}

function renderClusterPopup(cluster: ClusterModel): string {
  const lines = [
    `나무 수: ${formatInteger(cluster.size)}개`,
    `주요 자치구: ${escapeHtml(cluster.district)}`,
    `주요 수종: ${escapeHtml(cluster.species)}`,
    `추정 면적: ${formatArea(cluster.areaM2)}`,
    `추천 점수: ${cluster.score.toFixed(1)}`,
  ];

  return `<p class="popup-title">추천 벚꽃길 ${cluster.rank ?? cluster.clusterId}</p><p class="popup-body">${lines.join("<br />")}</p>`;
}

function geometryLabel(mode: Controls["geometryMode"]) {
  if (mode === "buffer") return "Buffer";
  if (mode === "convex") return "Convex";
  return "Concave";
}

function viewModeLabel(mode: Controls["viewMode"]) {
  if (mode === "points") return "포인트";
  if (mode === "areas") return "군집 영역";
  if (mode === "highlights") return "강조 구간";
  return "전체";
}

function formatInteger(value: number) {
  return Number(value || 0).toLocaleString("ko-KR");
}

function formatArea(areaM2: number) {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return "0m²";
  if (areaM2 >= 1_000_000) return `${(areaM2 / 1_000_000).toFixed(2)}km²`;
  if (areaM2 >= 10_000) return `${(areaM2 / 10_000).toFixed(2)}ha`;
  return `${Math.round(areaM2).toLocaleString("ko-KR")}m²`;
}

function formatMeters(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0m";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}km`;
  return `${Math.round(value).toLocaleString("ko-KR")}m`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
