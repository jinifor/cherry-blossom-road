import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";
import type {
  AnalysisResult,
  ClusterFeatureProperties,
  ClusterModel,
  Controls,
  HighlightCenterProperties,
  PointFeatureProperties,
  TreeRecord,
  ViewMode,
} from "../types";

export function analyzeTrees(trees: TreeRecord[], controls: Controls): AnalysisResult {
  const visibleTrees =
    controls.district === "ALL"
      ? trees.slice()
      : trees.filter((tree) => tree.district === controls.district);

  if (!visibleTrees.length) {
    return emptyAnalysis(controls);
  }

  const groups = buildConnectedComponents(visibleTrees, controls.distance);
  const displayedClusters: ClusterModel[] = [];
  const pointMeta = new Map<
    number,
    { clusterId: number; clusterSize: number; point: string }
  >();

  let clusterId = 1;
  for (const group of groups) {
    const members = group.map((index) => visibleTrees[index]);
    const geometry = createClusterGeometry(members, controls.geometryMode, controls.distance);
    if (!geometry) {
      clusterId += 1;
      continue;
    }

    const colors = clusterColor(clusterId);
    const cluster: ClusterModel = {
      clusterId,
      members,
      size: members.length,
      geometry,
      areaM2: turf.area(geometry),
      spanMeters: estimateSpanMeters(members),
      district: dominantValue(members.map((item) => item.district)),
      species: dominantValue(members.map((item) => item.species)),
      fill: colors.fill,
      line: colors.line,
      point: colors.point,
      score: 0,
    };

    members.forEach((tree) => {
      pointMeta.set(tree.id, {
        clusterId,
        clusterSize: members.length,
        point: colors.point,
      });
    });

    if (members.length >= controls.minClusterSize) {
      displayedClusters.push(cluster);
    }

    clusterId += 1;
  }

  displayedClusters.forEach((cluster) => {
    cluster.score = scoreCluster(cluster, controls.highlightMetric);
  });

  const highlights = displayedClusters
    .slice()
    .sort((a, b) => b.score - a.score || b.size - a.size)
    .slice(0, controls.highlightCount)
    .map((cluster, index) => ({ ...cluster, rank: index + 1 }));

  const highlightIds = new Set(highlights.map((cluster) => cluster.clusterId));

  return {
    controls,
    visibleTrees,
    displayedClusters,
    highlights,
    pointFeatures: buildPointFeatures(visibleTrees, pointMeta, highlightIds, controls.viewMode),
    clusterFeatures: buildClusterFeatures(displayedClusters, controls.viewMode),
    highlightFeatures: buildHighlightFeatures(highlights, controls.viewMode),
    highlightCenters: buildHighlightCenters(highlights, controls.viewMode),
  };
}

export function emptyAnalysis(controls: Controls): AnalysisResult {
  return {
    controls,
    visibleTrees: [],
    displayedClusters: [],
    highlights: [],
    pointFeatures: featureCollection<Point, PointFeatureProperties>([]),
    clusterFeatures: featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>([]),
    highlightFeatures: featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>([]),
    highlightCenters: featureCollection<Point, HighlightCenterProperties>([]),
  };
}

export function getBoundsFromTrees(trees: TreeRecord[]): [[number, number], [number, number]] | null {
  if (!trees.length) return null;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const tree of trees) {
    minLon = Math.min(minLon, tree.lon);
    maxLon = Math.max(maxLon, tree.lon);
    minLat = Math.min(minLat, tree.lat);
    maxLat = Math.max(maxLat, tree.lat);
  }

  if (minLon === maxLon) {
    minLon -= 0.005;
    maxLon += 0.005;
  }
  if (minLat === maxLat) {
    minLat -= 0.005;
    maxLat += 0.005;
  }

  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export function getBoundsFromCluster(cluster: ClusterModel): [[number, number], [number, number]] {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(cluster.geometry);
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export function getClusterCenter(cluster: ClusterModel): [number, number] {
  const center = turf.centroid(cluster.geometry);
  return center.geometry.coordinates as [number, number];
}

function buildConnectedComponents(trees: TreeRecord[], thresholdMeters: number): number[][] {
  const size = trees.length;
  const dsu = new DisjointSet(size);
  const averageLatitude = trees.reduce((sum, tree) => sum + tree.lat, 0) / size;
  const cellLat = thresholdMeters / 110574;
  const cellLon = thresholdMeters / (111320 * Math.max(Math.cos(toRadians(averageLatitude)), 0.2));
  const buckets = new Map<string, number[]>();

  for (let index = 0; index < size; index += 1) {
    const tree = trees[index];
    const gridX = Math.floor(tree.lon / cellLon);
    const gridY = Math.floor(tree.lat / cellLat);

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = buckets.get(`${gridX + dx}:${gridY + dy}`);
        if (!bucket) continue;

        for (const otherIndex of bucket) {
          if (distanceMeters(tree, trees[otherIndex]) <= thresholdMeters) {
            dsu.union(index, otherIndex);
          }
        }
      }
    }

    const key = `${gridX}:${gridY}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(index);
    } else {
      buckets.set(key, [index]);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < size; index += 1) {
    const root = dsu.find(index);
    const group = groups.get(root);
    if (group) {
      group.push(index);
    } else {
      groups.set(root, [index]);
    }
  }

  return Array.from(groups.values()).sort((a, b) => b.length - a.length);
}

function buildPointFeatures(
  trees: TreeRecord[],
  pointMeta: Map<number, { clusterId: number; clusterSize: number; point: string }>,
  highlightIds: Set<number>,
  viewMode: ViewMode,
): FeatureCollection<Point, PointFeatureProperties> {
  const showAllPoints = viewMode === "all" || viewMode === "points";
  const showHighlightPoints = viewMode === "highlights";

  return featureCollection<Point, PointFeatureProperties>(
    trees.flatMap((tree) => {
      const meta = pointMeta.get(tree.id);
      if (!meta) return [];

      const highlighted = highlightIds.has(meta.clusterId);
      if (!showAllPoints && !(showHighlightPoints && highlighted)) {
        return [];
      }

      return [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [tree.lon, tree.lat] },
          properties: {
            district: tree.district,
            species: tree.species,
            height: valueOrEmpty(tree.height),
            trunk: valueOrEmpty(tree.trunk),
            canopy: valueOrEmpty(tree.canopy),
            planted: tree.planted,
            clusterId: meta.clusterId,
            clusterSize: meta.clusterSize,
            pointColor: highlighted ? "#ff6f91" : meta.point,
            pointOpacity: highlighted ? 0.98 : 0.88,
          },
        },
      ];
    }),
  );
}

function buildClusterFeatures(
  clusters: ClusterModel[],
  viewMode: ViewMode,
): FeatureCollection<Polygon | MultiPolygon, ClusterFeatureProperties> {
  if (!(viewMode === "all" || viewMode === "areas")) {
    return featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>([]);
  }

  return featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>(
    clusters.map((cluster) => ({
      type: "Feature",
      geometry: cluster.geometry.geometry,
      properties: {
        clusterId: cluster.clusterId,
        size: cluster.size,
        district: cluster.district,
        species: cluster.species,
        areaM2: cluster.areaM2,
        score: cluster.score,
        fillColor: cluster.fill,
        lineColor: cluster.line,
      },
    })),
  );
}

function buildHighlightFeatures(
  highlights: ClusterModel[],
  viewMode: ViewMode,
): FeatureCollection<Polygon | MultiPolygon, ClusterFeatureProperties> {
  if (!(viewMode === "all" || viewMode === "highlights")) {
    return featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>([]);
  }

  return featureCollection<Polygon | MultiPolygon, ClusterFeatureProperties>(
    highlights.map((cluster) => ({
      type: "Feature",
      geometry: cluster.geometry.geometry,
      properties: {
        clusterId: cluster.clusterId,
        size: cluster.size,
        district: cluster.district,
        species: cluster.species,
        areaM2: cluster.areaM2,
        score: cluster.score,
      },
    })),
  );
}

function buildHighlightCenters(
  highlights: ClusterModel[],
  viewMode: ViewMode,
): FeatureCollection<Point, HighlightCenterProperties> {
  if (!(viewMode === "all" || viewMode === "highlights")) {
    return featureCollection<Point, HighlightCenterProperties>([]);
  }

  return featureCollection<Point, HighlightCenterProperties>(
    highlights.map((cluster) => {
      const center = turf.centroid(cluster.geometry) as Feature<Point>;
      return {
        type: "Feature",
        geometry: center.geometry,
        properties: {
          clusterId: cluster.clusterId,
          label: String(cluster.rank ?? cluster.clusterId),
        },
      };
    }),
  );
}

function createClusterGeometry(
  members: TreeRecord[],
  geometryMode: Controls["geometryMode"],
  distanceMetersValue: number,
): Feature<Polygon | MultiPolygon> | null {
  const pointFeatures = featureCollection(
    members.map((tree) => turf.point([tree.lon, tree.lat])),
  );

  if (members.length === 1) {
    return turf.circle([members[0].lon, members[0].lat], Math.max(distanceMetersValue, 6) / 1000, {
      units: "kilometers",
      steps: 28,
    }) as Feature<Polygon>;
  }

  if (members.length === 2) {
    return turf.buffer(
      turf.lineString(members.map((tree) => [tree.lon, tree.lat])),
      Math.max(distanceMetersValue * 0.45, 4) / 1000,
      { units: "kilometers", steps: 20 },
    ) as Feature<Polygon | MultiPolygon>;
  }

  if (geometryMode === "buffer") {
    return (
      buildBufferedGeometry(pointFeatures, distanceMetersValue) ??
      fallbackGeometry(pointFeatures, distanceMetersValue)
    );
  }

  if (geometryMode === "concave") {
    return (
      buildConcaveGeometry(pointFeatures, distanceMetersValue) ??
      buildConvexGeometry(pointFeatures, distanceMetersValue) ??
      fallbackGeometry(pointFeatures, distanceMetersValue)
    );
  }

  return (
    buildConvexGeometry(pointFeatures, distanceMetersValue) ??
    fallbackGeometry(pointFeatures, distanceMetersValue)
  );
}

function buildConcaveGeometry(
  pointFeatures: FeatureCollection<Point>,
  distanceMetersValue: number,
): Feature<Polygon | MultiPolygon> | null {
  if (pointFeatures.features.length < 4) {
    return null;
  }

  try {
    return turf.concave(pointFeatures, {
      units: "kilometers",
      maxEdge: Math.max(distanceMetersValue * 3, 45) / 1000,
    }) as Feature<Polygon | MultiPolygon> | null;
  } catch {
    return null;
  }
}

function buildConvexGeometry(
  pointFeatures: FeatureCollection<Point>,
  distanceMetersValue: number,
): Feature<Polygon | MultiPolygon> | null {
  try {
    const convex = turf.convex(pointFeatures) as Feature<Polygon | MultiPolygon> | null;
    if (convex) {
      return convex;
    }
  } catch {
    return fallbackGeometry(pointFeatures, distanceMetersValue);
  }

  return fallbackGeometry(pointFeatures, distanceMetersValue);
}

function buildBufferedGeometry(
  pointFeatures: FeatureCollection<Point>,
  distanceMetersValue: number,
): Feature<Polygon | MultiPolygon> | null {
  try {
    const buffered = turf.buffer(pointFeatures, Math.max(distanceMetersValue * 0.7, 7) / 1000, {
      units: "kilometers",
      steps: 18,
    }) as Feature<Polygon | MultiPolygon> | FeatureCollection<Polygon | MultiPolygon> | null;

    if (!buffered) {
      return null;
    }

    if (buffered.type === "FeatureCollection") {
      if (buffered.features.length === 1) {
        return buffered.features[0] as Feature<Polygon | MultiPolygon>;
      }

      return turf.convex(turf.explode(turf.combine(buffered))) as Feature<Polygon | MultiPolygon> | null;
    }

    return buffered;
  } catch {
    return null;
  }
}

function fallbackGeometry(
  pointFeatures: FeatureCollection<Point>,
  distanceMetersValue: number,
): Feature<Polygon | MultiPolygon> | null {
  try {
    return turf.buffer(
      turf.envelope(pointFeatures),
      Math.max(distanceMetersValue * 0.2, 2.5) / 1000,
      { units: "kilometers", steps: 12 },
    ) as Feature<Polygon | MultiPolygon>;
  } catch {
    return null;
  }
}

function scoreCluster(cluster: ClusterModel, metric: Controls["highlightMetric"]): number {
  const areaKm2 = Math.max(cluster.areaM2 / 1_000_000, 0.00035);
  const density = cluster.size / areaKm2;

  if (metric === "size") {
    return cluster.size;
  }
  if (metric === "density") {
    return density;
  }

  return cluster.size * Math.log10(density + 10);
}

function dominantValue(values: string[]): string {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  let winner = "";
  let winnerCount = -1;
  counts.forEach((count, value) => {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  });

  return winner || "미상";
}

function estimateSpanMeters(members: TreeRecord[]): number {
  if (members.length < 2) {
    return 0;
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const member of members) {
    minLon = Math.min(minLon, member.lon);
    maxLon = Math.max(maxLon, member.lon);
    minLat = Math.min(minLat, member.lat);
    maxLat = Math.max(maxLat, member.lat);
  }

  return distanceMeters({ lon: minLon, lat: minLat }, { lon: maxLon, lat: maxLat });
}

function clusterColor(clusterId: number): { fill: string; line: string; point: string } {
  const hue = (clusterId * 41) % 360;
  return {
    fill: `hsla(${hue}, 82%, 54%, 0.35)`,
    line: `hsl(${hue}, 76%, 44%)`,
    point: `hsl(${hue}, 74%, 48%)`,
  };
}

function distanceMeters(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const earthRadius = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function featureCollection<G extends Point | Polygon | MultiPolygon, P>(
  features: Array<Feature<G, P>>,
): FeatureCollection<G, P> {
  return {
    type: "FeatureCollection",
    features,
  };
}

function valueOrEmpty(value: number | null): string {
  return value === null || value === undefined ? "" : String(value);
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

class DisjointSet {
  private parent: Int32Array;
  private rank: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    this.rank = new Int32Array(size);
    for (let index = 0; index < size; index += 1) {
      this.parent[index] = index;
    }
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }

    if (this.rank[rootA] < this.rank[rootB]) {
      [rootA, rootB] = [rootB, rootA];
    }

    this.parent[rootB] = rootA;
    if (this.rank[rootA] === this.rank[rootB]) {
      this.rank[rootA] += 1;
    }
  }
}
