import type { PscRoute } from "./psc-config";

/**
 * Hard-coded PSC routes — the source of truth (previously Google Sheet GID 281585585).
 *
 * Why hard-coded: a per-instance / CDN-cached sheet read could serve stale config and create
 * wrong jobs (the via-leg staleness bug). A constant is byte-identical across every Vercel
 * instance and runtime, instant, and version-controlled. To change a route: edit here and
 * deploy (~2 min). Regenerate from the sheet by re-exporting CSV when needed.
 *
 * `address` and `ref_number` from the sheet are intentionally omitted: address is not part of
 * PscRoute (unused), and ref_number is ignored by psc-assign (it generates its own reference).
 */

// Hub / shared customer_ids reused as dropoffs and via targets (defined once to avoid drift).
const D001 = "3927b076-3af9-11ed-b939-506b8dbc8dfb";
const D004 = "1c89cd22-3d6b-11ed-b2d6-506b8dbc8dfb";
const D006 = "c07bc96a-3d81-11ed-989f-506b8dbc8dfb";
const D007 = "debfa9a0-3d81-11ed-9ba7-506b8dbc8dfb";
const D009 = "7e6eb83c-3d83-11ed-b414-506b8dbc8dfb";
const D032 = "17dd37b4-3d9d-11ed-93b6-506b8dbc8dfb";
const D037 = "ec32d0d2-ceec-11ee-bad2-506b8d9879b5";
const D046 = "16db29e0-73db-11ef-baa3-506b8d9879b5";
const D049 = "0df4f904-0f8b-11f0-b683-506b8d982279";
const D050 = "3d68332c-6698-11f0-a623-506b8d982279";

function route(
  psc_pickup: string,
  dropoff_location: string,
  pickup: string,
  dropoff: string,
  lat: number,
  lon: number,
  extra?: { via_pickup?: string; via_pickup_name?: string; no_request?: boolean }
): PscRoute {
  return {
    psc_pickup,
    dropoff_location,
    pickup,
    dropoff,
    ref_number: "",
    lat,
    lon,
    via_pickup: extra?.via_pickup ?? "",
    via_pickup_name: extra?.via_pickup_name ?? "",
    no_request: extra?.no_request ?? false,
  };
}

export const PSC_ROUTES: PscRoute[] = [
  route("BRA - D001", "BRA - D001", D001, D001, 10.775086, 106.672714, { no_request: true }),
  route("BRA - D002", "BRA - D001", "7bc36d6c-3d6a-11ed-a1ac-506b8dbc8dfb", D001, 10.756428, 106.673397),
  route("BRA - D003", "BRA - D001", "557ec732-3af9-11ed-b159-506b8dbc8dfb", D001, 10.799748, 106.669596),
  route("BRA - D004", "BRA - D001", D004, D001, 10.84737, 106.776574, { via_pickup: D046, via_pickup_name: "BRA - D046" }),
  route("BRA - D005", "BRA - D001", "c4f51f56-1ba8-11f1-9378-fa163ee8d8ac", D001, 10.767069, 106.64929),
  route("BRA - D006", "BRA - D001", D006, D001, 10.73842, 106.716414),
  route("BRA - D007", "BRA - D001", D007, D001, 10.858457, 106.748749, { via_pickup: D046, via_pickup_name: "BRA - D046" }),
  route("BRA - D009", "BRA - D001", D009, D001, 10.82720763, 106.6247449),
  route("BRA - D010", "BRA - D001", "9a15e7a4-3d83-11ed-be4e-506b8dbc8dfb", D001, 10.746023, 106.612324),
  route("BRA - D011", "BRA - D001", "bbdd2320-3d83-11ed-a15b-506b8dbc8dfb", D001, 10.79434659, 106.6381749),
  route("BRA - D014", "BRA - D007", "c79d5fa2-3d85-11ed-a6db-506b8dbc8dfb", D007, 10.979216, 106.655488, { via_pickup: D032, via_pickup_name: "BRA - D032" }),
  route("BRA - D015", "BRA - D004", "0c0b1998-3d88-11ed-8d9a-506b8dbc8dfb", D004, 10.947309, 106.828412),
  route("BRA - D016", "BRA - D007", "f61cca44-3d89-11ed-b141-506b8dbc8dfb", D007, 10.905611, 106.76818),
  route("BRA - D017", "BRA - D001", "6ec25112-3d8a-11ed-acb2-506b8dbc8dfb", D001, 10.809442, 106.695022),
  route("BRA - D018", "BRA - D001", "8d623ace-3d8a-11ed-87cc-506b8dbc8dfb", D001, 10.779712, 106.70079),
  route("BRA - D019", "BRA - D001", "a693faa0-3d8a-11ed-9fed-506b8dbc8dfb", D001, 10.792031, 106.73036),
  route("BRA - D020", "BRA - D001", "27eaf120-3d8c-11ed-9f85-506b8dbc8dfb", D001, 10.818625, 106.678662),
  route("BRA - D021", "3PL - D021 - TLT", "47cc1bf4-3d8c-11ed-95fc-506b8dbc8dfb", "4aa193d2-b1dd-11ef-b42b-506b8d9879b5", 10.35665, 106.361731),
  route("BRA - D022", "BRA - D001", "65d58b76-3d8c-11ed-b92b-506b8dbc8dfb", D001, 10.84253244, 106.6427306),
  route("BRA - D023", "3PL - D023 - TOT", "c0bd4c76-3d8d-11ed-892d-506b8dbc8dfb", "5e748868-446d-11ed-ac56-506b8dbc8dfb", 10.361207, 107.075646),
  route("BRA - D026", "BRA - D001", "c995bfaa-3d9b-11ed-9a28-506b8dbc8dfb", D001, 10.759073, 106.698812),
  route("BRA - D027", "BRA - D001", "fee8236e-3d9b-11ed-9cc5-506b8dbc8dfb", D001, 10.738902, 106.669958),
  route("BRA - D028", "BRA - D009", "90de3042-3d9c-11ed-a60a-506b8dbc8dfb", D009, 10.970374, 106.489534),
  route("BRA - D029", "BRA - D001", "c81985d4-3d9c-11ed-8951-506b8dbc8dfb", D001, 10.79036, 106.697328),
  route("BRA - D030", "3PL - D030 - THB", "c450f244-3b21-11f1-9378-fa163ee8d8ac", "b959ed68-446d-11ed-b04f-506b8dbc8dfb", 10.03381258, 105.7637348),
  route("BRA - D032", "BRA - D007", D032, D007, 10.90835, 106.70142),
  route("BRA - D033", "BRA - D009", "24b9b3d6-3d9d-11ed-b9a1-506b8dbc8dfb", D009, 10.888009, 106.598528),
  route("BRA - D035", "BRA - D006", "77531e70-3d9d-11ed-bccd-506b8dbc8dfb", D006, 10.715441, 106.737061),
  route("BRA - D036", "BRA - D001", "a22daf7a-3d9d-11ed-8890-506b8dbc8dfb", D001, 10.535476, 106.417043),
  route("BRA - D036", "3PL - D036 - TLT", "a22daf7a-3d9d-11ed-8890-506b8dbc8dfb", "8350b9b4-5e65-11ee-aa4d-506b8d9879b5", 10.535476, 106.417043),
  route("BRA - D037", "BRA - D001", D037, D001, 10.788097, 106.766239, { no_request: true }),
  route("BRA - D038", "BRA - D001", "cc143b9c-ceec-11ee-9518-506b8d9879b5", D001, 10.791934, 106.655502),
  route("BRA - D039", "BRA - D001", "b188329c-ceec-11ee-bae4-506b8d9879b5", D001, 10.751132, 106.634999, { via_pickup: D049, via_pickup_name: "BRA - D049" }),
  route("BRA - D040", "BRA - D001", "af190f62-0ce6-11ef-ba8a-506b8d9879b5", D001, 10.829273, 106.681601),
  route("BRA - D041", "BRA - D001", "21dcad6a-0ce7-11ef-af2f-506b8d9879b5", D001, 10.815858, 106.598525),
  route("BRA - D042", "BRA - D001", "37c8f934-0ce8-11ef-900c-506b8d9879b5", D001, 10.81819039, 106.7730649, { via_pickup: D037, via_pickup_name: "BRA - D037" }),
  route("BRA - D043", "BRA - D001", "e5c037c2-0ce9-11ef-a2d8-506b8d9879b5", D001, 10.77618193, 106.607045),
  route("BRA - D044", "BRA - D001", "ea93538a-5dd7-11ef-b329-506b8d9879b5", D001, 10.747607, 106.688976),
  route("BRA - D045", "BRA - D001", "088b3eac-73db-11ef-a38c-506b8d9879b5", D001, 10.790614, 106.688313, { via_pickup: D050, via_pickup_name: "BRA - D050" }),
  route("BRA - D046", "BRA - D001", D046, D001, 10.800274, 106.710945, { no_request: true }),
  route("BRA - D047", "BRA - D001", "21415bde-73db-11ef-8478-506b8d9879b5", D001, 10.761946, 106.65693),
  route("BRA - D048", "BRA - D001", "2d13fd86-73db-11ef-a0d1-506b8d9879b5", D001, 10.77995, 106.649843),
  route("BRA - D049", "BRA - D001", D049, D001, 10.753095, 106.650836),
  route("BRA - D050", "BRA - D001", D050, D001, 10.786807, 106.679405),
  route("BRA - D051", "BRA - D001", "4daa0bca-2d7b-11f1-9378-fa163ee8d8ac", D001, 10.80086399, 106.7345728),
];
