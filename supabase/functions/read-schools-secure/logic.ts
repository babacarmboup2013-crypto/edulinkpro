// Logique pure (sans réseau) de read-schools-secure : périmètre et filtrage des colonnes.
// Écrite avec une syntaxe TypeScript « effaçable » pour pouvoir être testée avec Node.

export type Scope = {
  kind: "root" | "ief" | "groupe" | "school";
  id?: string | null;
  canSeeCodes: boolean;     // peut lire schools.code et les codes du personnel
};

const SAFE_SCHOOL_COLUMNS = "id,name,type,cycle,cycles,ief_id,groupe_id,directeur,actif,created_at";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WORD_CODE = /(^|[^a-zA-Z0-9_])(code|codes)([^a-zA-Z0-9_]|$)/i;

export function isUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

// Construit la chaîne de requête PostgREST finale, ou renvoie une erreur.
// allowedSchoolIds : pour school_data hors racine, ids des écoles du périmètre.
export function buildQuery(
  table: string,
  rawParams: string,
  scope: Scope,
  allowedSchoolIds: string[] | null,
): { error?: string; query?: string } {
  if (table !== "schools" && table !== "school_data") return { error: "Table non autorisée" };
  const p = new URLSearchParams(rawParams || "");

  if (table === "schools") {
    let select = p.get("select");
    if (!scope.canSeeCodes) {
      // Aucun filtre / tri / alias sur la colonne « code ».
      for (const [k, v] of p.entries()) {
        if (k === "select") continue;
        if (k.toLowerCase() === "code" || WORD_CODE.test(v) || (k !== "order" && WORD_CODE.test(k)) || (k === "order" && WORD_CODE.test(v))) {
          return { error: "Colonne non autorisée" };
        }
      }
      if (!select || select.includes("*") || select.includes("(")) {
        select = SAFE_SCHOOL_COLUMNS;
      } else {
        select = select.split(",").filter((t) => !WORD_CODE.test(t)).join(",") || SAFE_SCHOOL_COLUMNS;
      }
      p.set("select", select);
    }
    if (scope.kind === "ief") p.append("ief_id", "eq." + scope.id);
    else if (scope.kind === "groupe") p.append("groupe_id", "eq." + scope.id);
    else if (scope.kind === "school") p.append("id", "eq." + scope.id);
    return { query: p.toString() };
  }

  // school_data
  const select = p.get("select") || "";
  if (!scope.canSeeCodes && /personnel/i.test(select)) return { error: "Colonne non autorisée" };
  if (scope.kind === "school") {
    p.append("school_id", "eq." + scope.id);
  } else if (scope.kind !== "root") {
    const ids = (allowedSchoolIds || []).filter(isUuid);
    if (!ids.length) return { query: "__empty__" };
    p.append("school_id", "in.(" + ids.join(",") + ")");
  }
  return { query: p.toString() };
}

// Retire les codes d'accès du personnel d'un payload (supervision en lecture seule).
function stripPayload(payload: any): any {
  if (payload && typeof payload === "object" && Array.isArray(payload.personnel)) {
    return { ...payload, personnel: payload.personnel.map((e: any) => {
      if (e && typeof e === "object") { const { code: _c, ...rest } = e; return rest; }
      return e;
    }) };
  }
  return payload;
}

export function sanitizeRows(table: string, rows: any, scope: Scope): any {
  if (scope.canSeeCodes || !Array.isArray(rows)) return rows;
  if (table === "schools") return rows.map((r: any) => { if (r && typeof r === "object") { const { code: _c, ...rest } = r; return rest; } return r; });
  return rows.map((r: any) => (r && typeof r === "object" && "payload" in r) ? { ...r, payload: stripPayload(r.payload) } : r);
}
