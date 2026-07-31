import fs from 'node:fs/promises';

const sourcePath = process.argv[2] || 'skilldocs-audit/audit.mjs';
const outputPath = process.argv[3] || 'skilldocs-audit/audit-runtime.mjs';
let source = await fs.readFile(sourcePath, 'utf8');
source = source.replace(/\r\n/g, '\n');

function replaceRequired(label, search, replacement) {
  if (!source.includes(search)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(search, replacement);
  console.log(`Patched: ${label}`);
}

function replaceBlock(label, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Patch start not found: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Patch end not found: ${label}`);
  source = source.slice(0, start) + replacement + source.slice(end);
  console.log(`Patched block: ${label}`);
}

replaceRequired(
  'RU master popup ID',
  "const expectedMasterPopupByLanguage = {\n  uk: '35414',",
  "const expectedMasterPopupByLanguage = {\n  ru: '33936',\n  uk: '35414',",
);

replaceRequired(
  'invalid DOM :visible selector',
  '.elementor-popup-modal:visible [data-elementor-id=',
  '.elementor-popup-modal [data-elementor-id=',
);

const newCandidateFunction = `function candidateShouldBeInteractionTested(candidate) {
  if (!candidate.visible || candidate.disabled) return false;
  if (candidate.tag === 'input' && ['submit', 'reset'].includes(candidate.type)) return false;
  if (candidate.formId || /\\b(form|wpcf7|wpforms)\\b/i.test(candidate.formClass)) {
    if (candidate.type === 'submit' || /submit|send|отправ|wys|надісл/i.test(candidate.text)) return false;
  }
  const identity = \`${'${candidate.classes} ${candidate.id}'}\`;
  if (/cookie|consent|cky-|cmplz|complianz/i.test(identity)) return false;
  if (/перейти к|przejdź do|skip to/i.test(candidate.text || '')) return false;
  const href = candidate.href.trim();
  const hasExplicitControl = Boolean(
    candidate.onclick || candidate.dataAction || candidate.ariaControls || candidate.ariaExpanded !== '' ||
    /elementor-button|popup|sd-open|sd-native|menu-toggle|hamburger|accordion|tab|toggle|swiper|carousel/i.test(identity)
  );
  if (href.startsWith('#') && !hasExplicitControl) return false;
  if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.includes('elementor-action')) return false;
  if (candidate.tag === 'a' && !href && !hasExplicitControl) return false;
  return true;
}`;
replaceBlock(
  'interaction candidate filtering',
  'function candidateShouldBeInteractionTested(candidate) {',
  '\n\nasync function getVisiblePopupInfo(page)',
  newCandidateFunction,
);

const newFormSignature = `function formSignature(form, pageLanguage, popupId = '') {
  const hiddenIds = form.fields
    .filter((f) => f.type === 'hidden')
    .filter((f) => /form_id|form_name|wpforms|wpcf7|forminator|fluent|gform/i.test(f.name))
    .filter((f) => !/post|page|referer|referrer|queried/i.test(f.name))
    .map((f) => \`${'${f.name}=${f.value}'}\`)
    .sort();
  const fieldShape = form.fields
    .filter((f) => !/honeypot|website|url|captcha/i.test(f.name))
    .map((f) => \`${'${f.tag}:${f.type}:${f.name}:${f.required ? 1 : 0}'}\`)
    .sort();
  const stableClassName = String(form.className || '').split(/\\s+/).filter((c) => /elementor-form|wpcf7|wpforms|forminator|fluent|gform/i.test(c)).sort();
  const raw = JSON.stringify({ pageLanguage, popupId, id: form.id, stableClassName, action: form.action, hiddenIds, fieldShape });
  return sha1(raw);
}`;
replaceBlock(
  'stable form deduplication',
  "function formSignature(form, pageLanguage, popupId = '') {",
  '\n\nasync function ensureAuditUploadFixtures()',
  newFormSignature,
);

replaceRequired(
  'explicit URL list support',
  '  let urls = await discoverFromSitemaps();',
  "  let urls = process.env.AUDIT_URLS\n    ? new Map(process.env.AUDIT_URLS.split(/[,\\r\\n]+/).map((u) => u.trim()).filter(Boolean).map((u) => [new URL(u, BASE_URL).href, { source: 'explicit-url-list' }]))\n    : await discoverFromSitemaps();",
);

replaceRequired(
  'do not call raw DOM mutation a confirmed success',
  "    } else if ((after.mutations || 0) > 0) {\n      result.status = 'ok';\n      result.effect = `dom-mutated:${after.mutations}`;",
  "    } else if ((after.mutations || 0) > 0) {\n      result.status = 'ambiguous';\n      result.effect = `dom-mutated:${after.mutations}`;",
);

replaceRequired(
  'mobile meaningful-controls coverage',
  "    const selectedCandidates = exhaustiveInteractions\n      ? interactionCandidates\n      : interactionCandidates.filter((c) => /popup|elementor-action|menu|nav|accordion|tab|sd-open|popup-trigger/i.test(`${c.href} ${c.classes} ${c.dataAction}`) || Boolean(c.ariaControls) || Boolean(c.ariaExpanded)).slice(0, 16);",
  "    const selectedCandidates = exhaustiveInteractions\n      ? interactionCandidates\n      : interactionCandidates.slice(0, 24);",
);

await fs.writeFile(outputPath, source, 'utf8');
console.log(`Wrote ${outputPath} (${source.length} characters)`);
