import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import * as turf from "@turf/turf";
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
  distance: 15,
  minClusterSize: 10,
  geometryMode: "buffer",
  highlightMetric: "hybrid",
  highlightCount: 5,
  district: "ALL",
  viewMode: "all",
};

type StatusTone = "info" | "success" | "warning";
type PanelTab = "controls" | "highlights";
type SummaryItem = {
  id: string;
  label: string;
  value: string;
  description: string;
  align: "left" | "right";
};

export default function App() {
  const [trees, setTrees] = useState<TreeRecord[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult>(emptyAnalysis(DEFAULT_CONTROLS));
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>("controls");
  const [statusMessage, setStatusMessage] = useState(
    "같은 폴더의 seoul_cb_tree.csv를 자동으로 읽고 있습니다.",
  );
  const [statusTone, setStatusTone] = useState<StatusTone>("info");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [openSummaryHelp, setOpenSummaryHelp] = useState<string | null>(null);

  const deferredControls = useDeferredValue(controls);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const sourcesReadyRef = useRef(false);
  const analysisRef = useRef<AnalysisResult>(analysis);
  const geolocationBufferTimeoutRef = useRef<number | null>(null);
  const geolocateZoomRef = useRef<number | null>(null);
  const didInitialFitRef = useRef(false);
  const pendingDistrictFitRef = useRef(false);

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

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
        visualizePitch: false,
      }),
      "bottom-left",
    );

    const geolocateControl = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: false,
      showUserLocation: true,
      showAccuracyCircle: false,
    });
    map.addControl(geolocateControl, "bottom-left");

    const geolocateButton = map
      .getContainer()
      .querySelector<HTMLButtonElement>(".maplibregl-ctrl-geolocate");
    const handleGeolocateClick = () => {
      geolocateZoomRef.current = map.getZoom();
    };
    geolocateButton?.addEventListener("click", handleGeolocateClick);

    map.on("load", () => {
      addSourcesAndLayers(map);
      bindMapInteractions(map, popupRef);
      sourcesReadyRef.current = true;
      renderAnalysisOnMap(map, analysisRef.current);
      if (!didInitialFitRef.current && analysisRef.current.visibleTrees.length > 0) {
        fitAnalysisBounds(map, analysisRef.current);
        didInitialFitRef.current = true;
      }
    });

    const handleGeolocate = (position: GeolocationPosition) => {
      const preservedZoom = geolocateZoomRef.current ?? map.getZoom();
      const center: [number, number] = [position.coords.longitude, position.coords.latitude];

      window.setTimeout(() => {
        map.easeTo({
          center,
          zoom: preservedZoom,
          duration: 900,
          essential: true,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
        geolocateZoomRef.current = null;
      }, 0);

      const buffer = turf.circle([position.coords.longitude, position.coords.latitude], 0.01, {
        units: "kilometers",
        steps: 48,
      });

      setSourceData(map, "geolocate-buffer", {
        type: "FeatureCollection",
        features: [buffer],
      });

      if (geolocationBufferTimeoutRef.current !== null) {
        window.clearTimeout(geolocationBufferTimeoutRef.current);
      }

      geolocationBufferTimeoutRef.current = window.setTimeout(() => {
        setSourceData(map, "geolocate-buffer", emptyFeatureCollection());
        geolocationBufferTimeoutRef.current = null;
      }, 5000);
    };

    geolocateControl.on("geolocate", handleGeolocate);
    mapRef.current = map;

    return () => {
      geolocateControl.off("geolocate", handleGeolocate);
      geolocateButton?.removeEventListener("click", handleGeolocateClick);
      if (geolocationBufferTimeoutRef.current !== null) {
        window.clearTimeout(geolocationBufferTimeoutRef.current);
      }
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
        setStatusMessage(`seoul_cb_tree.csv에서 ${formatInteger(nextTrees.length)}그루의 벚나무 데이터를 불러왔습니다.`);
        setStatusTone("success");
        didInitialFitRef.current = false;
      } catch {
        if (cancelled) return;
        setStatusMessage(
          "seoul_cb_tree.csv 자동 로드에 실패했습니다. 같은 디렉토리를 HTTP 서버로 열었는지 확인해 주세요.",
        );
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
      setStatusMessage("선택한 자치구에 표시할 데이터가 없습니다.");
      setStatusTone("warning");
      return;
    }

    if (nextAnalysis.displayedClusters.length > 0) {
      setStatusMessage(
        `${formatInteger(nextAnalysis.visibleTrees.length)}그루를 분석해 ${formatInteger(nextAnalysis.displayedClusters.length)}개 군집과 ${formatInteger(nextAnalysis.highlights.length)}개 추천 구간을 계산했습니다.`,
      );
      setStatusTone("success");
      return;
    }

    setStatusMessage(
      `${formatInteger(nextAnalysis.visibleTrees.length)}그루를 분석했습니다. 현재 조건에서는 군집 영역이 없어 포인트만 표시합니다.`,
    );
    setStatusTone("info");
  }, [trees, deferredControls]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;
    renderAnalysisOnMap(map, analysis);
    if (!didInitialFitRef.current && analysis.visibleTrees.length > 0) {
      fitAnalysisBounds(map, analysis);
      didInitialFitRef.current = true;
    }
    if (pendingDistrictFitRef.current) {
      pendingDistrictFitRef.current = false;
      if (analysis.visibleTrees.length > 0) {
        fitAnalysisBounds(map, analysis);
      }
    }
  }, [analysis]);

  function updateControl<K extends keyof Controls>(key: K, value: Controls[K]) {
    setOpenSummaryHelp(null);
    if (key === "district") {
      pendingDistrictFitRef.current = true;
    }
    startTransition(() => {
      setControls((current) => ({ ...current, [key]: value }));
    });
  }

  function resetControls() {
    setOpenSummaryHelp(null);
    startTransition(() => {
      setControls(DEFAULT_CONTROLS);
    });
  }

  function moveToHighlight(cluster: ClusterModel) {
    const map = mapRef.current;
    if (!map || !sourcesReadyRef.current) return;

    setIsMobileMenuOpen(false);

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

  const largestCluster = analysis.displayedClusters.length
    ? Math.max(...analysis.displayedClusters.map((cluster) => cluster.size))
    : 0;
  const averageCluster = analysis.displayedClusters.length
    ? analysis.displayedClusters.reduce((sum, cluster) => sum + cluster.size, 0) /
    analysis.displayedClusters.length
    : 0;
  const longestClusterSpan = analysis.displayedClusters.length
    ? Math.max(...analysis.displayedClusters.map((cluster) => cluster.spanMeters))
    : 0;

  const summaryItems: SummaryItem[] = [
    {
      id: "trees",
      label: "분석 나무 수",
      value: formatInteger(analysis.visibleTrees.length),
      description: "현재 조건과 필터를 통과해 분석에 반영된 벚나무 수입니다.",
      align: "left",
    },
    {
      id: "clusters",
      label: "형성된 군집 수",
      value: formatInteger(analysis.displayedClusters.length),
      description: "거리 조건으로 연결되어 하나의 벚꽃길 후보로 묶인 군집 개수입니다.",
      align: "right",
    },
    {
      id: "highlights",
      label: "추천 벚꽃길",
      value: formatInteger(analysis.highlights.length),
      description: "현재 결과 중 추천 점수가 높은 구간이 몇 개인지 보여줍니다.",
      align: "left",
    },
    {
      id: "largest",
      label: "최대 군집 규모",
      value: `${formatInteger(largestCluster)}그루`,
      description: "하나의 군집 안에 포함된 나무 수가 가장 많은 벚꽃길 후보입니다.",
      align: "right",
    },
    {
      id: "average",
      label: "평균 군집 규모",
      value: `${averageCluster.toFixed(1)}그루`,
      description: "군집 하나당 평균적으로 몇 그루의 나무가 묶였는지 보여줍니다.",
      align: "left",
    },
    {
      id: "span",
      label: "최장 군집 범위",
      value: formatMeters(longestClusterSpan),
      description: "형성된 군집 중에서 가장 길게 이어진 벚꽃길 후보의 범위입니다.",
      align: "right",
    },
  ];

  return (
    <div className="shell">
      <aside className={`panel${isMobileMenuOpen ? " is-open" : ""}`}>
        <div className="panel-mobile-bar">
          <div className="panel-mobile-title">분석 메뉴</div>
          <button
            className="panel-close-button"
            type="button"
            aria-label="메뉴 닫기"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            닫기
          </button>
        </div>

        <section className="hero card">
          <p className="eyebrow">Seoul Cherry Blossom Road Explorer</p>
          <h1>서울 벚꽃길 군집 분석</h1>
          <p className="hero-copy">
            CSV 자동 로드, 거리 기반 군집화, 군집 영역 생성, 추천 벚꽃길 탐색까지 한 번에 살펴볼 수 있도록
            구성했습니다.
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
          <p className="helper">서울 공공데이터 포털의 '서울시 가로수 위치정보'데이터를 기반으로 합니다.</p>
        </section>

        <section className="card tab-shell">
          <div className="tab-list" role="tablist" aria-label="왼쪽 패널 탭">
            {[
              { key: "controls", label: "분석조건" },
              { key: "highlights", label: "추천 벚꽃길" },
            ].map((tab) => (
              <button
                key={tab.key}
                className={`tab-button${activePanelTab === tab.key ? " is-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activePanelTab === tab.key}
                onClick={() => {
                  setActivePanelTab(tab.key as PanelTab);
                  setOpenSummaryHelp(null);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="tab-body">
            {activePanelTab === "controls" && (
              <div className="tab-panel">
                <div className="section-head">
                  <h2>분석조건</h2>
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
                      className="select-compact"
                      value={controls.district}
                      onChange={(event) => updateControl("district", event.target.value)}
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
                      className="select-compact"
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

                  <div className="field">
                    <span className="field-label">시각화 모드</span>
                    <div className="segmented">
                      {[
                        { value: "all", label: "전체" },
                        { value: "points", label: "위치" },
                        { value: "areas", label: "영역" },
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

                <section className="summary-section">
                  <div className="section-head">
                    <h2>요약</h2>
                  </div>
                  <p className="summary-note">
                    현재 분석 조건에서 만들어진 결과를 빠르게 훑어볼 수 있는 핵심 요약입니다. 물음표 버튼을 누르면
                    각 항목이 무엇을 뜻하는지 바로 확인할 수 있습니다.
                  </p>
                  <div className="stats-grid">
                    {summaryItems.map((item) => (
                      <article key={item.id} className="stat">
                        <div className="stat-head">
                          <span className="stat-label">{item.label}</span>
                          <span className="summary-help-wrap">
                            <button
                              className="summary-help"
                              type="button"
                              aria-label={`${item.label} 설명`}
                              aria-expanded={openSummaryHelp === item.id}
                              onClick={() =>
                                setOpenSummaryHelp((current) => (current === item.id ? null : item.id))
                              }
                            >
                              ?
                            </button>
                            {openSummaryHelp === item.id && (
                              <div
                                className={`summary-tooltip${item.align === "left" ? " is-left" : ""}`}
                                role="tooltip"
                              >
                                {item.description}
                              </div>
                            )}
                          </span>
                        </div>
                        <strong>{item.value}</strong>
                      </article>
                    ))}
                  </div>
                </section>
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
                    <li className="empty-state">현재 조건에서 추천할 벚꽃길이 없습니다.</li>
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
                                나무 {formatInteger(cluster.size)}그루 · 면적 {formatArea(cluster.areaM2)} · 범위 {formatMeters(cluster.spanMeters)}
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

      <button
        className={`panel-backdrop${isMobileMenuOpen ? " is-visible" : ""}`}
        type="button"
        aria-label="메뉴 닫기"
        onClick={() => setIsMobileMenuOpen(false)}
      ></button>

      <main className="map-shell">
        <button
          className="mobile-menu-button"
          type="button"
          aria-label="메뉴 열기"
          aria-expanded={isMobileMenuOpen}
          onClick={() => setIsMobileMenuOpen(true)}
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
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
  map.addSource("geolocate-buffer", {
    type: "geojson",
    data: emptyFeatureCollection(),
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
    id: "geolocate-buffer-fill",
    type: "fill",
    source: "geolocate-buffer",
    paint: {
      "fill-color": "#2f80ed",
      "fill-opacity": 0.14,
    },
  });
  map.addLayer({
    id: "geolocate-buffer-outline",
    type: "line",
    source: "geolocate-buffer",
    paint: {
      "line-color": "#2f80ed",
      "line-width": 2,
      "line-opacity": 0.9,
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
        ["coalesce", ["get", "trunkValue"], 0],
        0,
        2.8,
        6,
        4.2,
        10,
        5.1,
        20,
        7,
        30,
        8.4,
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
    `군집 규모: ${formatInteger(Number(properties.clusterSize ?? 1))}그루`,
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
    `나무 수: ${formatInteger(Number(properties.size ?? 0))}그루`,
    `주요 자치구: ${escapeHtml(String(properties.district ?? "미상"))}`,
    `주요 수종: ${escapeHtml(String(properties.species ?? "벚나무"))}`,
    `추정 면적: ${formatArea(Number(properties.areaM2 ?? 0))}`,
    `추천 점수: ${Number(properties.score ?? 0).toFixed(1)}`,
  ];

  return `<p class="popup-title">군집 ${escapeHtml(String(properties.clusterId ?? "-"))}</p><p class="popup-body">${lines.join("<br />")}</p>`;
}

function renderClusterPopup(cluster: ClusterModel): string {
  const lines = [
    `나무 수: ${formatInteger(cluster.size)}그루`,
    `주요 자치구: ${escapeHtml(cluster.district)}`,
    `주요 수종: ${escapeHtml(cluster.species)}`,
    `추정 면적: ${formatArea(cluster.areaM2)}`,
    `추천 점수: ${cluster.score.toFixed(1)}`,
  ];

  return `<p class="popup-title">추천 벚꽃길 ${cluster.rank ?? cluster.clusterId}</p><p class="popup-body">${lines.join("<br />")}</p>`;
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

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [],
  };
}
