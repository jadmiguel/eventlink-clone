import { downloadCsv } from "@/utils/downloadCsv";
import { emailMeetsAdminPolicy, ISU_EMAIL_ERROR, EMAIL_FORMAT_ERROR } from "@/utils/isuEmail";

export const STAFF_IMPORT_MAX_BYTES = 1_000_000;
export const STAFF_IMPORT_MAX_ROWS = 100;

export type StaffImportKind = "adviser" | "dean";
export type StaffImportStatus = "Valid" | "Invalid" | "Duplicate" | "Warning";

export type StaffImportRow = {
  row: number;
  fullName: string;
  email: string;
  college: string;
  program: string;
  organization: string;
  position: string;
};

export type StaffImportPreviewRow = StaffImportRow & {
  status: StaffImportStatus;
  message: string;
};

export type StaffImportCatalog = {
  requireIsuEmail: boolean;
  colleges: Array<{
    id: string;
    name: string;
    code: string | null;
    organizations: Array<{ id: string; name: string; slug: string | null }>;
    programs: Array<{ id: string; name: string }>;
  }>;
  portalUsers: Array<{ email: string; role: string; college: string }>;
  orgAssignments: Array<{ organizationId: string; role: string; displayName: string }>;
};

type HeaderField = "full_name" | "email" | "college" | "program" | "organization" | "position";

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
  if (["full_name", "fullname", "name"].includes(x)) return "full_name";
  if (["email", "e_mail", "e-mail"].includes(x)) return "email";
  if (["college", "college_name"].includes(x)) return "college";
  if (["program", "program_name"].includes(x)) return "program";
  if (["organization", "organization_name", "org"].includes(x)) return "organization";
  if (["position", "title"].includes(x)) return "position";
  return null;
}

export function staffRoleLabel(kind: StaffImportKind): string {
  return kind === "dean" ? "Dean" : "Adviser";
}

export function isStaffExampleRow(row: StaffImportRow): boolean {
  return (
    row.fullName.trim().toLowerCase().startsWith("example ") ||
    row.email.trim().toLowerCase().startsWith("example.") ||
    row.college.trim().toLowerCase().startsWith("example ")
  );
}

function requiredHeaders(kind: StaffImportKind): HeaderField[] {
  return kind === "dean"
    ? ["full_name", "email", "college", "position"]
    : ["full_name", "email", "college", "program", "position"];
}

function rowFromCells(
  cells: string[],
  headerMap: { index: number; key: HeaderField }[],
  rowIndex: number,
): StaffImportRow | null {
  const obj: Partial<Record<HeaderField, string>> = {};
  for (const { index, key } of headerMap) obj[key] = cells[index] ?? "";
  const fullName = (obj.full_name ?? "").trim();
  const email = (obj.email ?? "").trim();
  const college = (obj.college ?? "").trim();
  const program = (obj.program ?? "").trim();
  const organization = (obj.organization ?? "").trim();
  const position = (obj.position ?? "").trim();
  if (!fullName && !email && !college && !program && !organization) return null;
  return { row: rowIndex, fullName, email, college, program, organization, position };
}

function parseGrid(rows: string[][], kind: StaffImportKind): StaffImportRow[] {
  if (rows.length < 2) throw new Error("The file has no data rows.");
  const headerMap: { index: number; key: HeaderField }[] = [];
  const rawHeaders = rows[0]!.map((value) => normalizeHeader(String(value ?? "")));
  if (rawHeaders.includes("password")) {
    throw new Error("Do not include a password column. Invitees set their own password.");
  }
  if (rawHeaders.includes("employee_id") || rawHeaders.includes("student_id")) {
    throw new Error(
      kind === "dean"
        ? "Dean import columns must be exactly: full_name, email, college, position."
        : "Adviser import columns must be exactly: full_name, email, college, program, position.",
    );
  }
  rows[0]!.forEach((value, index) => {
    const key = headerKey(String(value ?? ""));
    if (key && !headerMap.some((h) => h.key === key)) headerMap.push({ index, key });
  });
  const keys = new Set(headerMap.map((h) => h.key));
  const required = requiredHeaders(kind);
  if (required.some((key) => !keys.has(key))) {
    throw new Error(
      kind === "dean"
        ? "The file must include full_name, email, college, and position."
        : "The file must include full_name, email, college, program, and position.",
    );
  }
  const parsed: StaffImportRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rowFromCells(rows[i] ?? [], headerMap, i + 1);
    if (row) parsed.push(row);
  }
  return parsed;
}

export function parseStaffCsv(text: string, kind: StaffImportKind): StaffImportRow[] {
  return parseGrid(
    text
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((line) => splitCsvLine(line)),
    kind,
  );
}

export async function parseStaffXlsx(buffer: ArrayBuffer, kind: StaffImportKind): Promise<StaffImportRow[]> {
  const { readSheet } = await import("read-excel-file/browser");
  const sheetRows = await readSheet(buffer);
  return parseGrid(
    sheetRows.map((row) => row.map((value) => String(value ?? "").trim())),
    kind,
  );
}

export function downloadStaffTemplate(kind: StaffImportKind): void {
  if (kind === "dean") {
    downloadCsv("eventlink-dean-template.csv", [
      ["full_name", "email", "college", "position"],
      ["EXAMPLE Dean", "example.dean@isu.edu.ph", "EXAMPLE College of Computing Studies", "Dean"],
    ]);
    return;
  }
  downloadCsv("eventlink-adviser-template.csv", [
    ["full_name", "email", "college", "program", "position"],
    [
      "EXAMPLE Adviser",
      "example.adviser@isu.edu.ph",
      "EXAMPLE College of Computing Studies",
      "EXAMPLE Information Technology",
      "Program Adviser",
    ],
  ]);
}

function resolveCollege(catalog: StaffImportCatalog, collegeName: string) {
  return catalog.colleges.filter(
    (c) =>
      c.name.trim().toLowerCase() === collegeName.trim().toLowerCase() ||
      (c.code ?? "").toLowerCase() === collegeName.trim().toLowerCase(),
  );
}

export function validateStaffImportRows(
  rows: StaffImportRow[],
  catalog: StaffImportCatalog,
  kind: StaffImportKind,
): StaffImportPreviewRow[] {
  const label = staffRoleLabel(kind);
  const portalEmails = new Set(catalog.portalUsers.map((u) => u.email.trim().toLowerCase()).filter(Boolean));
  const deanByCollege = new Map(
    catalog.portalUsers
      .filter((u) => u.role === "dean" && u.college.trim())
      .map((u) => [u.college.trim().toLowerCase(), u]),
  );
  const seenEmail = new Set<string>();
  const seenCollege = new Set<string>();
  const out: StaffImportPreviewRow[] = [];

  for (const row of rows) {
    if (isStaffExampleRow(row)) continue;
    const email = row.email.trim().toLowerCase();
    const preview: StaffImportPreviewRow = { ...row, email, status: "Valid", message: `Ready to invite as ${label}.` };

    if (!row.fullName.trim()) {
      preview.status = "Invalid";
      preview.message = "Full name is required.";
    } else if (!emailMeetsAdminPolicy(email, catalog.requireIsuEmail)) {
      preview.status = "Invalid";
      preview.message = catalog.requireIsuEmail ? ISU_EMAIL_ERROR : EMAIL_FORMAT_ERROR;
    } else if (!row.college.trim()) {
      preview.status = "Invalid";
      preview.message = "College is required.";
    } else if (kind === "adviser" && !row.program.trim()) {
      preview.status = "Invalid";
      preview.message = "Program is required.";
    } else if (!row.position.trim()) {
      preview.status = "Invalid";
      preview.message = "Position is required.";
    } else if (seenEmail.has(email)) {
      preview.status = "Invalid";
      preview.message = `Duplicate row: email ${email} appears more than once in this file.`;
    } else if (portalEmails.has(email)) {
      preview.status = "Duplicate";
      preview.message = "Email already belongs to an existing EventLink account.";
    } else {
      seenEmail.add(email);
      const collegeMatches = resolveCollege(catalog, row.college);
      if (!collegeMatches.length) {
        preview.status = "Invalid";
        preview.message = `College "${row.college}" was not found.`;
      } else if (collegeMatches.length > 1) {
        preview.status = "Invalid";
        preview.message = `Multiple colleges match "${row.college}".`;
      } else {
        const college = collegeMatches[0]!;
        if (kind === "dean") {
          const collegeKey = college.name.trim().toLowerCase();
          if (seenCollege.has(collegeKey)) {
            preview.status = "Invalid";
            preview.message = `Duplicate row: college "${college.name}" already has a Dean in this file.`;
          } else if (deanByCollege.has(collegeKey) || deanByCollege.has((college.code ?? "").toLowerCase())) {
            preview.status = "Duplicate";
            preview.message = `College "${college.name}" already has a registered Dean.`;
          } else {
            seenCollege.add(collegeKey);
            preview.status = "Valid";
            preview.message = `Will invite this user as Dean of ${college.name}.`;
          }
        } else {
          const programKey = row.program.trim().toLowerCase();
          const programMatches = college.programs.filter(
            (program) => program.name.trim().toLowerCase() === programKey,
          );
          if (!programMatches.length) {
            preview.status = "Invalid";
            preview.message = `Program "${row.program}" was not found under "${college.name}".`;
          } else if (programMatches.length > 1) {
            preview.status = "Invalid";
            preview.message = `Multiple programs match "${row.program}" in "${college.name}".`;
          } else {
            preview.status = "Valid";
            preview.message = `Will invite this user as Adviser of ${programMatches[0]!.name}.`;
          }
        }
      }
    }
    out.push(preview);
  }
  return out;
}

export function staffImportCanConfirm(rows: StaffImportPreviewRow[]): boolean {
  return rows.some((r) => r.status === "Valid" || r.status === "Warning");
}
