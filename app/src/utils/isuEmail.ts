/** Official ISU email domain used for staff accounts. */
export const ISU_EMAIL_DOMAIN = "isu.edu.ph";

export const ISU_EMAIL_ERROR = "Please use a valid ISU email address.";

export const EMAIL_FORMAT_ERROR = "Enter a valid email address.";

function emailParts(email: string): { local: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  return { local, domain };
}

export function isValidEmailAddress(email: string): boolean {
  const parts = emailParts(email);
  if (!parts) return false;
  const { domain } = parts;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return !domain.includes(" ") && !parts.local.includes(" ");
}

export function isOfficialIsuEmail(email: string): boolean {
  const parts = emailParts(email);
  return Boolean(parts?.local) && parts?.domain === ISU_EMAIL_DOMAIN;
}

/** UX helper only. Server-side admin-create-user always re-reads app_settings. */
export function emailMeetsAdminPolicy(email: string, requireIsuEmail: boolean): boolean {
  if (!isValidEmailAddress(email)) return false;
  if (requireIsuEmail) return isOfficialIsuEmail(email);
  return true;
}
