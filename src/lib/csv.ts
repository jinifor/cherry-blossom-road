import Papa from "papaparse";
import type { TreeRecord } from "../types";

export function parseTreeCsv(text: string): TreeRecord[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  return normalizeTrees(result.data);
}

export function decodeCsvBuffer(buffer: ArrayBuffer): string {
  const utf8Text = new TextDecoder("utf-8").decode(buffer);
  if (looksLikeTreeCsv(utf8Text)) {
    return utf8Text;
  }

  try {
    const koreanText = new TextDecoder("euc-kr").decode(buffer);
    return looksLikeTreeCsv(koreanText) ? koreanText : utf8Text;
  } catch {
    return utf8Text;
  }
}

function looksLikeTreeCsv(text: string): boolean {
  return text.includes("WDPT_NM") && (text.includes("X,") || text.includes("LNG"));
}

function normalizeTrees(rows: Record<string, string>[]): TreeRecord[] {
  const trees: TreeRecord[] = [];
  let index = 1;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const lon = toNumber(firstValue(row, ["LNG", "X", "longitude", "lon", "lng"]));
    const lat = toNumber(firstValue(row, ["LAT", "Y", "latitude", "lat"]));
    if (lon === null || lat === null) continue;

    trees.push({
      id: index,
      lon,
      lat,
      district: repairMojibake(firstValue(row, ["GU_NM", "GU"])) || "미상",
      species: repairMojibake(firstValue(row, ["WDPT_NM", "WDPT"])) || "벚나무",
      height: toNumber(row.THT_HG),
      trunk: toNumber(row.BHT_DM),
      canopy: toNumber(row.WTRTB_BT),
      planted: repairMojibake(firstValue(row, ["PLT_DE", "CREAT_DE"])) || "",
    });

    index += 1;
  }

  return trees;
}

function firstValue(object: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = object[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function repairMojibake(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[가-힣]/.test(text)) return text;
  if (/^[\x00-\x7F]+$/.test(text)) return text;

  try {
    const repaired = decodeURIComponent(escape(text));
    if (/[가-힣]/.test(repaired)) {
      return repaired;
    }
  } catch {
    return text;
  }

  return text;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/,/g, "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}
