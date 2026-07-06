// Repository config + GitHub link helpers for the collaborative (static) flow.
// Collaborators update the flash cards by editing measures.json via PR or by
// opening a prefilled issue; CI validates; Pages rebuilds; and because links use
// the stable #/m/:id permalink, updated cards show through automatically.

export const REPO = {
  owner: "Hamidreza-Hashempoor",
  name: "Hamidreza-Hashempoor.github.io",
  branch: "master",
  dataPath: "blog/distances-dictionary/data/measures.json",
};

export function repoUrl() {
  return `https://github.com/${REPO.owner}/${REPO.name}`;
}
export function blobUrl() {
  return `${repoUrl()}/blob/${REPO.branch}/${REPO.dataPath}`;
}
/** GitHub web editor for measures.json. */
export function editUrl() {
  return `${repoUrl()}/edit/${REPO.branch}/${REPO.dataPath}`;
}
/** Prefilled new-issue URL (title/body/labels via query params). */
export function issueUrl({ title = "", body = "", labels = "" } = {}) {
  const p = new URLSearchParams();
  if (title) p.set("title", title);
  if (body) p.set("body", body);
  if (labels) p.set("labels", labels);
  return `${repoUrl()}/issues/new?${p.toString()}`;
}
/** "Suggest an edit" issue for an existing card. */
export function editCardIssueUrl(measure) {
  const title = `Edit: ${measure.canonical_name} (${measure.id})`;
  const body =
    `Proposed change to dictionary entry \`${measure.id}\`.\n\n` +
    `Describe the correction/addition (aliases, formula, identities, inequalities, code, …):\n\n\n` +
    `---\nEntry file: ${blobUrl()}`;
  return issueUrl({ title, body, labels: "dictionary" });
}
/** "Propose new entry" issue carrying a drafted JSON entry. */
export function newCardIssueUrl(entry) {
  const id = (entry && entry.id) || "new-measure";
  const json = "```json\n" + JSON.stringify(entry, null, 2) + "\n```";
  const body = `Proposed new dictionary entry (please review before merging):\n\n${json}`;
  return issueUrl({ title: `New measure: ${id}`, body, labels: "dictionary,new-entry" });
}
