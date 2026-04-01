import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from "geojson";

export type GeometryMode = "concave" | "convex" | "buffer";
export type HighlightMetric = "hybrid" | "size" | "density";
export type ViewMode = "all" | "points" | "areas" | "highlights";

export interface TreeRecord {
  id: number;
  lon: number;
  lat: number;
  district: string;
  species: string;
  height: number | null;
  trunk: number | null;
  canopy: number | null;
  planted: string;
}

export interface Controls {
  distance: number;
  minClusterSize: number;
  geometryMode: GeometryMode;
  highlightMetric: HighlightMetric;
  highlightCount: number;
  district: string;
  viewMode: ViewMode;
}

export interface PointFeatureProperties {
  district: string;
  species: string;
  height: string;
  trunk: string;
  trunkValue: number;
  canopy: string;
  planted: string;
  clusterId: number;
  clusterSize: number;
  pointColor: string;
  pointOpacity: number;
}

export interface ClusterFeatureProperties {
  clusterId: number;
  size: number;
  district: string;
  species: string;
  areaM2: number;
  score: number;
  fillColor?: string;
  lineColor?: string;
}

export interface HighlightCenterProperties {
  clusterId: number;
  label: string;
}

export interface ClusterModel {
  clusterId: number;
  members: TreeRecord[];
  size: number;
  geometry: Feature<Polygon | MultiPolygon>;
  areaM2: number;
  spanMeters: number;
  district: string;
  species: string;
  fill: string;
  line: string;
  point: string;
  score: number;
  rank?: number;
}

export interface AnalysisResult {
  controls: Controls;
  visibleTrees: TreeRecord[];
  displayedClusters: ClusterModel[];
  highlights: ClusterModel[];
  pointFeatures: FeatureCollection<Point, PointFeatureProperties>;
  clusterFeatures: FeatureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>;
  highlightFeatures: FeatureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>;
  highlightCenters: FeatureCollection<Point, HighlightCenterProperties>;
}
