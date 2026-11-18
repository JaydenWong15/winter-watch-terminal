// Builds data/routes-summary.json and data/winter-history.json from the raw
// sourced datasets in data/raw/. Re-run with: node scripts/build-data.mjs
import fs from "node:fs";

const RAW = new URL("../data/raw/", import.meta.url);
const OUT = new URL("../data/", import.meta.url);

function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// --- Routes ---------------------------------------------------------------
const geo = JSON.parse(fs.readFileSync(new URL("dlr-gritting-routes.geojson", RAW), "utf8"));

const routes = geo.features.map((f, i) => {
  let lenM = 0;
  let sx = 0, sy = 0, n = 0;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const line of f.geometry.coordinates) {
    for (let j = 1; j < line.length; j++) lenM += haversineMeters(line[j - 1], line[j]);
    for (const [lon, lat] of line) {
      sx += lon; sy += lat; n++;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return {
    id: `R${i + 1}`,
    name: f.properties.Name,
    length_km: Math.round((lenM / 1000) * 10) / 10,
    centroid: { lon: Math.round((sx / n) * 10000) / 10000, lat: Math.round((sy / n) * 10000) / 10000 },
    bbox: [minLon, minLat, maxLon, maxLat],
    // One regular truck per route, per DLR's Winter Service Plan 2024/2025 (section 3.2, p.21/22):
    // "10 trucks ... a fleet of 10 trucks ... one being assigned to each route"
    assignedTruck: `T${i + 1}`,
  };
});

fs.writeFileSync(
  new URL("routes-summary.json", OUT),
  JSON.stringify(
    {
      source: "Dún Laoghaire-Rathdown County Council — Gritting Routes (data.gov.ie, CC-BY 4.0)",
      source_url: "https://data.gov.ie/dataset/gritting-routes-dlr",
      retrieved: "2026-11-18",
      note: "Route length computed by Winter Watch from the published WGS84 line geometry (haversine), not from the dataset's own Shape__Len field (units/CRS not stated).",
      routes,
    },
    null,
    1
  )
);
console.log(`routes-summary.json: ${routes.length} routes, total ${routes.reduce((s, r) => s + r.length_km, 0).toFixed(1)}km`);

// --- Winter history ---------------------------------------------------------
const raw = fs.readFileSync(new URL("met-eireann-dublin-airport-dly532.csv", RAW), "utf8");
const lines = raw.split("\n");
const headerIdx = lines.findIndex((l) => l.startsWith("date,ind"));
const header = lines[headerIdx].split(",").map((s) => s.trim());
const idx = {};
header.forEach((h, i) => (idx[h] = i));
const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(d) {
  const [dd, mon, yyyy] = d.split("-");
  return new Date(Number(yyyy), months[mon], Number(dd));
}

const dataRows = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0);

const winters = {};
for (const line of dataRows) {
  const cols = line.split(",");
  const dateStr = cols[0];
  const dt = parseDate(dateStr);
  const m = dt.getMonth();
  let winterYear;
  if (m === 10 || m === 11) winterYear = dt.getFullYear() + 1;
  else if (m <= 2) winterYear = dt.getFullYear();
  else continue;

  const mintp = parseFloat(cols[idx["mintp"]]);
  const gmin = parseFloat(cols[idx["gmin"]]);
  const rain = parseFloat(cols[idx["rain"]]);

  if (!winters[winterYear])
    winters[winterYear] = {
      winterYear,
      days: 0,
      airFrostNights: 0,
      groundFrostNights: 0,
      icyRainNights: 0,
      excludedMintp: 0,
      excludedGmin: 0,
      excludedRain: 0,
    };
  const w = winters[winterYear];
  w.days++;

  const mintpOk = !Number.isNaN(mintp);
  const gminOk = !Number.isNaN(gmin);
  const rainOk = !Number.isNaN(rain);
  if (!mintpOk) w.excludedMintp++;
  if (!gminOk) w.excludedGmin++;
  if (!rainOk) w.excludedRain++;

  if (mintpOk && mintp <= 0) w.airFrostNights++;
  if (gminOk && gmin <= 0) w.groundFrostNights++;
  if (gminOk && rainOk && gmin <= 0 && rain > 0.2) w.icyRainNights++;
}

const allYears = Object.keys(winters).map(Number).sort((a, b) => a - b);
// Exclude the current, still-incomplete winter (the one ending in the latest calendar year on file)
const lastDate = parseDate(dataRows[dataRows.length - 1].split(",")[0]);
const currentWinterYear = lastDate.getMonth() >= 10 ? lastDate.getFullYear() + 1 : lastDate.getMonth() <= 2 ? lastDate.getFullYear() : null;
const completeYears = allYears.filter((y) => y !== currentWinterYear);
const last10 = completeYears.slice(-10);

fs.writeFileSync(
  new URL("winter-history.json", OUT),
  JSON.stringify(
    {
      source: "Met Éireann — Dublin Airport daily data, station 532 (CC-BY 4.0)",
      source_url: "https://data.gov.ie/dataset/dublin-airport-daily-data",
      retrieved: "2026-11-18",
      stationCoords: { lat: 53.428, lon: -6.241, elevation_m: 71 },
      definitions: {
        winterYear: "Winter spans Nov(prev year)-Mar(this year); labelled by the January year.",
        airFrostNights: "Days where mintp (min air temp) <= 0C",
        groundFrostNights: "Days where gmin (09utc grass min temp) <= 0C — best available proxy for road/ground frost",
        icyRainNights: "Days where gmin <= 0C AND rain > 0.2mm — rain that likely froze on contact",
        excludedFields: "Count of days in that winter where the reading was missing or flagged not-available and was dropped from that specific stat (day itself is kept).",
      },
      winters: completeYears.map((y) => winters[y]),
      last10WinterYears: last10,
      availableWinters: allYears.length,
      caveat:
        "All figures are from ONE lowland coastal station (71m). DLR's higher routes (Mountain, Rathmichael, Ballyogan, Dalkey-Killiney) are not directly measured here — see FLAGS-LOG F2.",
    },
    null,
    1
  )
);
console.log(`winter-history.json: ${allYears.length} winters on file, using last ${last10.length} complete winters: ${last10[0]}-${last10[last10.length - 1]}`);
