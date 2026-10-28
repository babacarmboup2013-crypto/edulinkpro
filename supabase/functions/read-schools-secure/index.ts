import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildQuery, isUuid, sanitizeRows, type Scope } from "./logic.ts";

// Proxy de LECTURE SEULE pour schools / school_data, AVEC authentification.
// Chaque requête doit prouver son identité (code vérifié côté serveur, avec la
// protection anti-essais répétés des RPC) et n'obtient que son périmètre :
//  - admin_code                     → Super Admin racine (ou admin IEF si le code est celui d'une IEF)
//  - ief_id + ief_admin_code        → admin IEF décentralisé (son IEF, codes visibles)
//  - ief_code (+ ief_kind=groupe)   → lecture seule IEF / groupe scolaire (sans aucun code d'accès)
//  - school_id + school_code        → une école, la sienne
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, KEY, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const rest = (qs: string, table: string) =>
  fetch(`${URL_}/rest/v1/${table}?${qs}`, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });

async function authenticate(b: any): Promise<Scope | null> {
  if (b.admin_code) {
    const { data, error } = await admin.rpc("check_admin_code", { p_code: String(b.admin_code) });
    if (!error && data?.ok === true) {
      return data.ief_id ? { kind: "ief", id: data.ief_id, canSeeCodes: true } : { kind: "root", canSeeCodes: true };
    }
  }
  if (b.ief_id && b.ief_admin_code && isUuid(b.ief_id)) {
    const { data, error } = await admin.rpc("check_ief_admin_code", { p_ief_id: b.ief_id, p_code: String(b.ief_admin_code) });
    if (!error && data === true) return { kind: "ief", id: b.ief_id, canSeeCodes: true };
  }
  if (b.ief_code) {
    if (b.ief_kind === "groupe") {
      const { data, error } = await admin.rpc("check_groupe_code", { p_code: String(b.ief_code) });
      if (!error && data?.ok === true && data.groupe_id) return { kind: "groupe", id: data.groupe_id, canSeeCodes: false };
    } else {
      const { data, error } = await admin.rpc("check_ief_code", { p_code: String(b.ief_code) });
      if (!error && data?.ok === true) {
        // ief_id null = code historique partagé (lecture de toutes les écoles, sans codes d'accès)
        return data.ief_id ? { kind: "ief", id: data.ief_id, canSeeCodes: false } : { kind: "root", canSeeCodes: false };
      }
    }
  }
  if (b.school_id && b.school_code && isUuid(b.school_id)) {
    const { data, error } = await admin.rpc("check_school_code", { p_school_id: b.school_id, p_code: String(b.school_code) });
    if (!error && data === true) return { kind: "school", id: b.school_id, canSeeCodes: true };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const table = b?.table;
    if (table !== "schools" && table !== "school_data") return json({ error: "Table non autorisée" }, 400);

    const scope = await authenticate(b);
    if (!scope) return json({ error: "Non autorisé" }, 401);

    let allowed: string[] | null = null;
    if (table === "school_data" && scope.kind !== "root" && scope.kind !== "school") {
      const col = scope.kind === "ief" ? "ief_id" : "groupe_id";
      const r = await rest(`select=id&${col}=eq.${scope.id}`, "schools");
      const rows = r.ok ? await r.json() : [];
      allowed = Array.isArray(rows) ? rows.map((x: any) => x.id) : [];
    }

    const built = buildQuery(table, String(b.params || ""), scope, allowed);
    if (built.error) return json({ error: built.error }, 403);
    if (built.query === "__empty__") return json([]);

    const res = await rest(built.query!, table);
    const text = await res.text();
    if (!res.ok) return new Response(text, { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });
    let rows: unknown;
    try { rows = JSON.parse(text); } catch { return new Response(text, { status: 200, headers: { ...cors, "Content-Type": "application/json" } }); }
    return json(sanitizeRows(table, rows, scope));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Erreur inconnue" }, 500);
  }
});
