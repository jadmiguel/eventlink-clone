import { downloadCsv } from "@/utils/downloadCsv";

export const COLLEGE_ORG_IMPORT_MAX_BYTES = 1_000_000;
export const COLLEGE_ORG_IMPORT_MAX_ROWS = 200;

export type CollegeOrgImportStatus = "Valid" | "Duplicate" | "Invalid" | "Warning";

export type CollegeOrgImportRow = {
  row: number;
  collegeName: string;
  programName: string;
  programRequired: boolean;
  organizationName: string;
  organizationCode: string;
};

export type CollegeOrgImportPreviewRow = CollegeOrgImportRow & {
  status: CollegeOrgImportStatus;
  message: string;
};

export type CollegeOrgCatalogCollege = {
  name: string;
  organizations: { name: string; slug: string | null }[];
};

type HeaderField = "college_name" | "program_name" | "organization_name" | "organization_code";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQ = !inQ;
      continue;
    }
    if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

function headerKey(h: string): HeaderField | null {
  const x = normalizeHeader(h);
  if (["college_name", "college", "college_title"].includes(x)) return "college_name";
  if (["program_name", "program"].includes(x)) return "program_name";
  if (["organization_name", "organization", "org_name", "org"].includes(x)) return "organization_name";
  if (["organization_code", "org_code", "code", "slug"].includes(x)) return "organization_code";
  return null;
}

export function normalizeOrganizationCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ACRONYM_STOP_WORDS = new Set(["a", "an", "and", "da", "de", "for", "in", "of", "the"]);

/** Short words stay whole (IT, ICT, JPIA). Longer words contribute their first letter. */
export function nameAcronym(value: string): string {
  const tokens = value.trim().match(/[A-Za-z0-9]+/g) ?? [];
  let code = "";
  for (const token of tokens) {
    if (ACRONYM_STOP_WORDS.has(token.toLowerCase())) continue;
    code += token.length <= 5 ? token.toUpperCase() : token[0]!.toUpperCase();
  }
  return code;
}

/** College-program-organization, for example CCS-IT-ICTS. */
export function organizationAcronymCode(
  collegeName: string,
  programName: string,
  organizationName: string,
): string {
  return [nameAcronym(collegeName), nameAcronym(programName), nameAcronym(organizationName)]
    .filter(Boolean)
    .join("-")
    .slice(0, 64);
}

export function isCollegeOrgExampleRow(
  row: Pick<CollegeOrgImportRow, "collegeName" | "programName" | "organizationName" | "organizationCode">,
): boolean {
  const college = row.collegeName.trim().toLowerCase();
  const program = row.programName.trim().toLowerCase();
  const org = row.organizationName.trim().toLowerCase();
  const code = normalizeOrganizationCode(row.organizationCode);
  return (
    college.startsWith("example ") ||
    program.startsWith("example ") ||
    org.startsWith("example ") ||
    code.startsWith("example-")
  );
}

function rowFromCells(
  cells: string[],
  headerMap: { index: number; key: HeaderField }[],
  rowIndex: number,
  programRequired: boolean,
): CollegeOrgImportRow | null {
  const obj: Partial<Record<HeaderField, string>> = {};
  for (const { index, key } of headerMap) {
    obj[key] = cells[index] ?? "";
  }
  const collegeName = (obj.college_name ?? "").trim();
  const programName = (obj.program_name ?? "").trim();
  const organizationName = (obj.organization_name ?? "").trim();
  const organizationCode = (obj.organization_code ?? "").trim();
  if (!collegeName && !programName && !organizationName && !organizationCode) return null;
  return { row: rowIndex, collegeName, programName, programRequired, organizationName, organizationCode };
}

function parseGrid(rows: string[][]): CollegeOrgImportRow[] {
  if (rows.length < 2) {
    throw new Error("The file has no data rows.");
  }
  const headerMap: { index: number; key: HeaderField }[] = [];
  rows[0]!.forEach((value, index) => {
    const key = headerKey(String(value ?? ""));
    if (key && !headerMap.some((h) => h.key === key)) headerMap.push({ index, key });
  });
  const keys = new Set(headerMap.map((h) => h.key));
  if (!keys.has("college_name") || !keys.has("organization_name")) {
    throw new Error("The file must include college_name and organization_name columns.");
  }
  const programRequired = keys.has("program_name");

  const parsed: CollegeOrgImportRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rowFromCells(rows[i] ?? [], headerMap, i + 1, programRequired);
    if (row) parsed.push(row);
  }
  return parsed;
}

export function parseCollegeOrgCsv(text: string): CollegeOrgImportRow[] {
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return parseGrid(rawLines.map((line) => splitCsvLine(line)));
}

export async function parseCollegeOrgXlsx(buffer: ArrayBuffer): Promise<CollegeOrgImportRow[]> {
  const { readSheet } = await import("read-excel-file/browser");
  const sheetRows = await readSheet(buffer);
  return parseGrid(sheetRows.map((row) => row.map((value) => String(value ?? "").trim())));
}

export function downloadCollegeOrgTemplate(): void {
  downloadCsv("eventlink-college-organization-template.csv", [
    ["college_name", "program_name", "organization_name", "organization_code"],
    ["EXAMPLE College of Computing Studies", "EXAMPLE Information Technology", "EXAMPLE ICT Society", "CCS-IT-ICTS"],
    ["EXAMPLE College of Business", "EXAMPLE Accountancy", "EXAMPLE Junior Philippine Institute of Accountants", "CB-A-JPIA"],
  ]);
}

export function validateCollegeOrgImportRows(
  rows: CollegeOrgImportRow[],
  catalog: CollegeOrgCatalogCollege[],
): CollegeOrgImportPreviewRow[] {
  const collegesByName = new Map<string, CollegeOrgCatalogCollege[]>();
  for (const college of catalog) {
    const key = college.name.trim().toLowerCase();
    const list = collegesByName.get(key) ?? [];
    list.push(college);
    collegesByName.set(key, list);
  }

  const seenName = new Set<string>();
  const seenSlug = new Set<string>();
  const out: CollegeOrgImportPreviewRow[] = [];

  for (const row of rows) {
    if (isCollegeOrgExampleRow(row)) continue;

    const collegeName = row.collegeName.trim();
    const programName = row.programName.trim();
    const organizationName = row.organizationName.trim();
    const organizationCode = organizationAcronymCode(collegeName, programName, organizationName);
    const preview: CollegeOrgImportPreviewRow = {
      row: row.row,
      collegeName,
      programName,
      programRequired: row.programRequired,
      organizationName,
      organizationCode,
      status: "Valid",
      message: organizationCode
        ? `Code ${organizationCode} is the acronym of the college, program, and organization.`
        : "New organization will be created.",
    };

    if (!collegeName) {
      preview.status = "Invalid";
      preview.message = "College name is required.";
    } else if (row.programRequired && !programName) {
      preview.status = "Invalid";
      preview.message = "Program name is required.";
    } else if (programName.length > 200) {
      preview.status = "Invalid";
      preview.message = "Program name is too long.";
    } else if (!organizationName) {
      preview.status = "Invalid";
      preview.message = "Organization name is required.";
    } else if (!organizationCode) {
      preview.status = "Invalid";
      preview.message = "Could not build an organization code from these names.";
    } else if (collegeName.length > 200 || organizationName.length > 200 || organizationCode.length > 64) {
      preview.status = "Invalid";
      preview.message = "A value is too long.";
    } else if (organizationCode.toLowerCase() === "ssc") {
      preview.status = "Invalid";
      preview.message = 'Organization code "ssc" is reserved for the university-wide SSC organization.';
    } else {
      const nameKey = `${collegeName.toLowerCase()}\u001f${organizationName.toLowerCase()}`;
      const slugKey = `${collegeName.toLowerCase()}\u001f${organizationCode}`;
      if (seenName.has(nameKey)) {
        preview.status = "Invalid";
        preview.message = `Duplicate row: organization "${organizationName}" under "${collegeName}" appears more than once in this file.`;
      } else if (seenSlug.has(slugKey)) {
        preview.status = "Invalid";
        preview.message = `Duplicate organization code "${organizationCode}" under "${collegeName}" in this file.`;
      } else {
        seenName.add(nameKey);
        seenSlug.add(slugKey);
        const matches = collegesByName.get(collegeName.toLowerCase()) ?? [];
        if (matches.length > 1) {
          preview.status = "Invalid";
          preview.message = `Multiple colleges are named "${collegeName}". Rename the duplicates in Admin before importing.`;
        } else if (matches.length === 1) {
          const college = matches[0]!;
          const existingByName = college.organizations.find(
            (org) => org.name.trim().toLowerCase() === organizationName.toLowerCase(),
          );
          if (existingByName) {
            if (programName) {
              preview.status = "Warning";
              preview.message = `Organization "${organizationName}" already exists. It will be placed under program "${programName}".`;
            } else {
              preview.status = "Duplicate";
              preview.message = `Organization "${organizationName}" already exists under "${collegeName}".`;
            }
          } else {
            const existingBySlug = college.organizations.find(
              (org) => (org.slug ?? "").trim().toLowerCase() === organizationCode.toLowerCase(),
            );
            if (existingBySlug) {
              preview.status = "Invalid";
              preview.message = `Organization code "${organizationCode}" is already used by "${existingBySlug.name}" under "${collegeName}".`;
            } else {
              preview.status = "Valid";
              preview.message = "New organization will be added to the existing college.";
            }
          }
        } else {
          preview.status = "Warning";
          preview.message = `College "${collegeName}" will be created with this organization.`;
        }
      }
    }

    out.push(preview);
  }

  return out;
}

export function collegeOrgImportHasBlockers(rows: CollegeOrgImportPreviewRow[]): boolean {
  return rows.some((row) => row.status === "Invalid") || rows.length === 0;
}
