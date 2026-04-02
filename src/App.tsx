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
import { createBlossomLayer } from "./lib/blossomLayer";
import { decodeCsvBuffer, parseTreeCsv } from "./lib/csv";
import type { AnalysisResult, ClusterModel, Controls, TreeRecord } from "./types";

const BLOSSOM_LAYER_ID = "blossom-petals";
const BUILDING_EXTRUSION_LAYER_ID = "ofm-buildings-3d";
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
type TrackingMode = "off" | "starting" | "on";
type OrientationMode = "off" | "on" | "unsupported" | "blocked";
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
  const [trackingMode, setTrackingMode] = useState<TrackingMode>("off");
  const [orientationMode, setOrientationMode] = useState<OrientationMode>("off");
  const [trackingError, setTrackingError] = useState<string | null>(null);

  const deferredControls = useDeferredValue(controls);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const sourcesReadyRef = useRef(false);
  const analysisRef = useRef<AnalysisResult>(analysis);
  const didInitialFitRef = useRef(false);
  const pendingDistrictFitRef = useRef(false);
  const geolocationWatchIdRef = useRef<number | null>(null);
  const latestTrackedPositionRef = useRef<GeolocationPosition | null>(null);
  const hasTrackedPositionRef = useRef(false);
  const orientationEventNameRef = useRef<"deviceorientation" | "deviceorientationabsolute" | null>(null);
  const orientationListenerRef = useRef<((event: DeviceOrientationEvent) => void) | null>(null);
  const trackingControlButtonRef = useRef<HTMLButtonElement | null>(null);
  const handleTrackingToggleRef = useRef<() => Promise<void>>(async () => { });

  const districts = Array.from(new Set(trees.map((tree) => tree.district))).sort((a, b) =>
    a.localeCompare(b, "ko"),
  );

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  useEffect(() => {
    handleTrackingToggleRef.current = handleTrackingToggle;
  });

  useEffect(() => {
    const applyViewportHeight = () => {
      const nextHeight = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
      window.requestAnimationFrame(() => {
        mapRef.current?.resize();
      });
    };

    applyViewportHeight();
    window.addEventListener("resize", applyViewportHeight);
    window.addEventListener("orientationchange", applyViewportHeight);
    window.visualViewport?.addEventListener("resize", applyViewportHeight);
    window.visualViewport?.addEventListener("scroll", applyViewportHeight);

    return () => {
      window.removeEventListener("resize", applyViewportHeight);
      window.removeEventListener("orientationchange", applyViewportHeight);
      window.visualViewport?.removeEventListener("resize", applyViewportHeight);
      window.visualViewport?.removeEventListener("scroll", applyViewportHeight);
    };
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    let trackingControlContainer: HTMLDivElement | null = null;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [126.978, 37.5665],
      zoom: 15,
      pitch: 50,
    });

    map.addControl(
      new maplibregl.NavigationControl({
        showZoom: false,
        showCompass: true,
        visualizePitch: false,
      }),
      "bottom-left",
    );
    map.addControl(
      {
        onAdd() {
          const container = document.createElement("div");
          container.className = "maplibregl-ctrl maplibregl-ctrl-group";
          container.addEventListener("contextmenu", preventDefaultContextMenu);
          trackingControlContainer = container;

          const button = document.createElement("button");
          button.type = "button";
          button.className = "maplibregl-ctrl-geolocate";

          const icon = document.createElement("span");
          icon.className = "maplibregl-ctrl-icon";
          icon.setAttribute("aria-hidden", "true");

          button.append(icon);
          button.addEventListener("click", handleTrackingControlClick);
          container.append(button);
          trackingControlButtonRef.current = button;
          syncTrackingControlButton(button);

          return container;
        },
        onRemove() {
          trackingControlButtonRef.current?.removeEventListener("click", handleTrackingControlClick);
          trackingControlContainer?.removeEventListener("contextmenu", preventDefaultContextMenu);
          trackingControlContainer?.remove();
          trackingControlContainer = null;
          trackingControlButtonRef.current = null;
        },
      },
      "bottom-left",
    );

    map.on("load", () => {
      addSourcesAndLayers(map);
      syncBlossomLayer(map, true);
      bindMapInteractions(map, popupRef);
      sourcesReadyRef.current = true;
      renderAnalysisOnMap(map, analysisRef.current);
      renderTrackedPosition(map, latestTrackedPositionRef.current);
      if (!didInitialFitRef.current && analysisRef.current.visibleTrees.length > 0) {
        fitAnalysisBounds(map, analysisRef.current);
        didInitialFitRef.current = true;
      }
    });
    mapRef.current = map;

    return () => {
      stopTracking(false);
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

  useEffect(() => {
    syncTrackingControlButton();
  }, [trackingMode, orientationMode, trackingError]);

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

  function handleTrackingControlClick() {
    void handleTrackingToggleRef.current();
  }

  function preventDefaultContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  async function handleTrackingToggle() {
    if (trackingMode === "starting") return;

    if (trackingMode === "on") {
      stopTracking();
      return;
    }

    await startTracking();
  }

  async function startTracking() {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setTrackingError("이 브라우저에서는 위치 추적을 지원하지 않습니다.");
      setOrientationMode("unsupported");
      return;
    }

    stopTracking(false);
    setTrackingMode("starting");
    setTrackingError(null);
    hasTrackedPositionRef.current = false;

    const nextOrientationMode = await enableOrientationTracking();
    setOrientationMode(nextOrientationMode);

    try {
      geolocationWatchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          latestTrackedPositionRef.current = position;
          const map = mapRef.current;
          const isFirstFix = !hasTrackedPositionRef.current;
          hasTrackedPositionRef.current = true;

          if (map) {
            renderTrackedPosition(map, position);
            focusTrackedPosition(map, position, isFirstFix);
          }

          setTrackingMode("on");
        },
        (error) => {
          stopTracking(false, true);
          setTrackingMode("off");
          setOrientationMode("off");
          setTrackingError(getGeolocationErrorMessage(error));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000,
        },
      );
    } catch {
      stopTracking(false, true);
      setTrackingMode("off");
      setOrientationMode("off");
      setTrackingError("위치 추적을 시작하지 못했습니다.");
    }
  }

  function stopTracking(resetState = true, rotateNorth = resetState) {
    if (geolocationWatchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(geolocationWatchIdRef.current);
      geolocationWatchIdRef.current = null;
    }

    disableOrientationTracking();
    latestTrackedPositionRef.current = null;
    hasTrackedPositionRef.current = false;

    const map = mapRef.current;
    if (map) {
      renderTrackedPosition(map, null);
      if (rotateNorth && bearingDelta(map.getBearing(), 0) > 0.5) {
        map.easeTo({
          bearing: 0,
          duration: 550,
          essential: true,
        });
      }
    }

    if (resetState) {
      setTrackingMode("off");
      setOrientationMode("off");
      setTrackingError(null);
    }
  }

  function syncTrackingControlButton(button = trackingControlButtonRef.current) {
    if (!button) return;

    const isPressed = trackingMode === "starting" || trackingMode === "on";
    const geolocationSupported = typeof window !== "undefined" && "geolocation" in navigator;
    const label =
      trackingMode === "starting"
        ? "위치 추적 시작 중"
        : trackingMode === "on"
          ? orientationMode === "on"
            ? "현재 위치 추적과 지도 회전 끄기"
            : "현재 위치 추적 끄기"
          : trackingError ?? "현재 위치 추적 켜기";

    button.classList.toggle("maplibregl-ctrl-geolocate-active", isPressed);
    button.classList.toggle("maplibregl-ctrl-geolocate-waiting", trackingMode === "starting");
    button.disabled = !geolocationSupported;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", isPressed ? "true" : "false");
    button.setAttribute("aria-busy", trackingMode === "starting" ? "true" : "false");
  }

  async function enableOrientationTracking(): Promise<OrientationMode> {
    if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") {
      return "unsupported";
    }

    const permission = await requestOrientationPermission();
    if (permission === "unsupported" || permission === "blocked") {
      return permission;
    }

    disableOrientationTracking();

    const eventName =
      "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    const handleOrientation = (event: DeviceOrientationEvent) => {
      const nextBearing = getOrientationBearing(event);
      if (nextBearing === null) return;

      const map = mapRef.current;
      if (!map) return;

      if (bearingDelta(map.getBearing(), nextBearing) < 1.5) {
        return;
      }

      map.setBearing(nextBearing);
    };

    window.addEventListener(eventName, handleOrientation, true);
    orientationEventNameRef.current = eventName;
    orientationListenerRef.current = handleOrientation;
    return "on";
  }

  function disableOrientationTracking() {
    if (
      typeof window !== "undefined" &&
      orientationEventNameRef.current &&
      orientationListenerRef.current
    ) {
      window.removeEventListener(
        orientationEventNameRef.current,
        orientationListenerRef.current,
        true,
      );
    }

    orientationEventNameRef.current = null;
    orientationListenerRef.current = null;
  }

  function focusTrackedPosition(map: maplibregl.Map, position: GeolocationPosition, isFirstFix: boolean) {
    const center: [number, number] = [position.coords.longitude, position.coords.latitude];
    const nextZoom = isFirstFix ? Math.max(map.getZoom(), 16) : map.getZoom();

    map.easeTo({
      center,
      zoom: nextZoom,
      duration: isFirstFix ? 900 : 550,
      essential: true,
      easing: (t) => 1 - Math.pow(1 - t, 3),
    });
  }

  function renderTrackedPosition(map: maplibregl.Map, position: GeolocationPosition | null) {
    if (!sourcesReadyRef.current) return;

    if (!position) {
      setSourceData(map, "geolocate-buffer", emptyFeatureCollection());
      setSourceData(map, "user-location", emptyFeatureCollection());
      return;
    }

    const center: [number, number] = [position.coords.longitude, position.coords.latitude];
    const accuracyMeters = Math.max(position.coords.accuracy || 0, 8);
    const accuracyCircle = turf.circle(center, accuracyMeters / 1000, {
      units: "kilometers",
      steps: 48,
    });

    setSourceData(map, "geolocate-buffer", {
      type: "FeatureCollection",
      features: [accuracyCircle],
    });
    setSourceData(map, "user-location", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: center },
          properties: {},
        },
      ],
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
          <h1>여기 벚꽃길이었네?</h1>
          <p className="hero-copy">
            벚꽃 시즌만 되면 괜히 발걸음이 가벼워지죠. 평소엔 그냥 스쳐 지나가던 길도, 알고 보면 근사한 벚꽃길일지 몰라요.
            지금 있는 동네에 숨은 벚꽃 명소가 있는지, 또 내 주변에서 가장 가깝고 분위기 좋은 곳은 어디인지 지금 바로 찾아보세요.
          </p>
          <p className="hero-footnote">
            서울 공공데이터 포털의 &#39;서울시 가로수 위치정보&#39; 데이터를 기반으로 만들었어요.
            유명 벚꽃 명소 외에 숨은 벚꽃길을 찾아보세요.
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
        </section>

        <section className="card tab-shell">
          <div className="tab-list" role="tablist" aria-label="왼쪽 패널 탭">
            {[
              { key: "controls", label: "보기 설정" },
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
                  <h2>보기 설정</h2>
                </div>

                <label className="field">
                  <div className="field-row">
                    <span className="field-label">가까운 거리 기준</span>
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
                    <span>가까운 나무끼리 묶기</span>
                    <span>30m</span>
                  </div>
                </label>

                <div className="grid two">
                  <label className="field">
                    <span className="field-label">최소 나무 개수</span>
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
                    <span className="field-label">보고 싶은 구</span>
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
                    <span className="field-label">길 범위 표시</span>
                    <select
                      className="select-compact"
                      value={controls.geometryMode}
                      onChange={(event) =>
                        updateControl("geometryMode", event.target.value as Controls["geometryMode"])
                      }
                    >
                      <option value="concave">길 따라 자연스럽게</option>
                      <option value="convex">바깥선 기준으로</option>
                      <option value="buffer">조금 넉넉하게</option>
                    </select>
                  </label>

                  <div className="field">
                    <span className="field-label">지도에서 보기</span>
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
                  처음 설정으로 돌아가기
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
                <p className="highlight-note">
                  추천 점수 = 나무 수 × log10(밀도 + 10)
                  <br />
                  나무가 많고, 좁은 범위에 더 촘촘하게 모여 있을수록 높은 점수를 받아요.
                </p>
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
        <div className="mobile-menu-bar">
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
          <div className="mobile-menu-title-chip">여기 벚꽃길이었네?</div>
        </div>
        <div ref={mapContainerRef} id="map" aria-label="서울 벚나무 분석 지도"></div>
      </main>
    </div>
  );
}

function addSourcesAndLayers(map: maplibregl.Map) {
  addBuildingExtrusionLayer(map);
  map.addSource("trees", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).pointFeatures });
  map.addSource("clusters", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).clusterFeatures });
  map.addSource("highlights", { type: "geojson", data: emptyAnalysis(DEFAULT_CONTROLS).highlightFeatures });
  map.addSource("highlight-centers", {
    type: "geojson",
    data: emptyAnalysis(DEFAULT_CONTROLS).highlightCenters,
  });
  map.addSource("user-location", {
    type: "geojson",
    data: emptyFeatureCollection(),
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
  map.addLayer({
    id: "user-location-point",
    type: "circle",
    source: "user-location",
    paint: {
      "circle-radius": 7.5,
      "circle-color": "#2f80ed",
      "circle-opacity": 0.96,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.2,
    },
  });
}

function addBuildingExtrusionLayer(map: maplibregl.Map) {
  if (map.getLayer(BUILDING_EXTRUSION_LAYER_ID) || !map.getSource("openmaptiles")) {
    return;
  }

  const firstSymbolLayerId = map
    .getStyle()
    .layers?.find((layer) => layer.type === "symbol")?.id;

  map.addLayer(
    {
      id: BUILDING_EXTRUSION_LAYER_ID,
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14.5,
      filter: ["all", ["has", "render_height"], ["!=", ["get", "hide_3d"], 1]],
      paint: {
        "fill-extrusion-color": "#d8d4cc",
        "fill-extrusion-height": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14.5,
          0,
          15.5,
          ["coalesce", ["get", "render_height"], 0],
        ],
        "fill-extrusion-base": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14.5,
          0,
          15.5,
          ["coalesce", ["get", "render_min_height"], 0],
        ],
        "fill-extrusion-opacity": 0.86,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    firstSymbolLayerId,
  );
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

async function requestOrientationPermission(): Promise<Exclude<OrientationMode, "off" | "on"> | "ready"> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") {
    return "unsupported";
  }

  const orientationEvent = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<"granted" | "denied">;
  };

  if (typeof orientationEvent.requestPermission !== "function") {
    return "ready";
  }

  try {
    const result = await orientationEvent.requestPermission();
    return result === "granted" ? "ready" : "blocked";
  } catch {
    return "blocked";
  }
}

function getOrientationBearing(event: DeviceOrientationEvent): number | null {
  const orientationEvent = event as DeviceOrientationEvent & {
    webkitCompassHeading?: number;
  };

  if (
    typeof orientationEvent.webkitCompassHeading === "number" &&
    Number.isFinite(orientationEvent.webkitCompassHeading)
  ) {
    return normalizeBearing(orientationEvent.webkitCompassHeading);
  }

  if (typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
    return normalizeBearing(360 - event.alpha);
  }

  return null;
}

function normalizeBearing(value: number) {
  return ((value % 360) + 360) % 360;
}

function bearingDelta(current: number, next: number) {
  const diff = Math.abs(normalizeBearing(current) - normalizeBearing(next));
  return Math.min(diff, 360 - diff);
}

function getGeolocationErrorMessage(error: GeolocationPositionError) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "위치 권한이 거부되어 추적을 시작할 수 없습니다.";
    case error.POSITION_UNAVAILABLE:
      return "현재 위치를 확인할 수 없습니다. GPS 또는 네트워크 상태를 확인해 주세요.";
    case error.TIMEOUT:
      return "위치 확인 시간이 초과되었습니다. 다시 시도해 주세요.";
    default:
      return "위치 추적 중 오류가 발생했습니다.";
  }
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

function syncBlossomLayer(map: maplibregl.Map, enabled: boolean) {
  const hasLayer = Boolean(map.getLayer(BLOSSOM_LAYER_ID));

  if (enabled && !hasLayer) {
    map.addLayer(
      createBlossomLayer({
        id: BLOSSOM_LAYER_ID,
        opacity: 0.8,
        petalCount: 202,
      }),
    );
    return;
  }

  if (!enabled && hasLayer) {
    map.removeLayer(BLOSSOM_LAYER_ID);
  }
}
