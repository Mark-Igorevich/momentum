import fs from 'node:fs/promises';

const sourcePath = process.argv[2] || 'skilldocs-audit/audit.mjs';
const outputPath = process.argv[3] || 'skilldocs-audit/audit-runtime.mjs';
let source = await fs.readFile(sourcePath, 'utf8');

function replaceRequired(label, search, replacement) {
  if (!source.includes(search)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  source = source.replace(search, replacement);
  console.log(`Patched: ${label}`);
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

const oldCandidateFunction = `function candidateShouldBeInteractionTested(candidate) {
  if (!candidate.visible || candidate.disabled) return false;
  if (candidate.tag === 'input' && ['submit', 'reset'].includes(candidate.type)) return false;
  if (candidate.formId || /\\b(form|wpcf7|wpforms)\\b/i.test(candidate.formClass)) {
    if (candidate.type === 'submit' || /submit|send|отправ|wys|надісл/i.test(candidate.text)) return false;
  }
  if (/cookie|consent|cky-|cmplz|complianz/i.test(\`${'${candidate.classes} ${candidate.id}'}\`)) return false;
  const href = candidate.href.trim();
  if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.includes('elementor-action')) return false;
  if (candidate.tag === 'a' && !href && !candidate.onclick && !candidate.dataAction && !candidate.ariaControls) return false;
  return true;
}`;

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
  if ((href === '#' || href === '#pll_switcher') && !hasExplicitControl) return false;
  if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.includes('elementor-action')) return false;
  if (candidate.tag === 'a' && !href && !hasExplicitControl) return false;
  return true;
}`;
replaceRequired('interaction candidate filtering', oldCandidateFunction, newCandidateFunction);

const oldFormSignature = `function formSignature(form, pageLanguage, popupId = '') {
  const hiddenIds = form.fields
    .filter((f) => f.type === 'hidden' && /(?:form|wpcf7|wpforms|id|post)/i.test(f.name))
    .map((f) => \`${'${f.name}=${f.value}'}\`)
    .sort();
  const fieldShape = form.fields.map((f) => \`${'${f.tag}:${f.type}:${f.name}:${f.required ? 1 : 0}'}\`).sort();
  const raw = JSON.stringify({ pageLanguage, popupId, id: form.id, className: form.className, action: form.action, hiddenIds, fieldShape });
  return sha1(raw);
}`;

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
replaceRequired('stable form deduplication', oldFormSignature, newFormSignature);

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

await fs.writeFile(outputPath, source, 'utf8');
console.log(`Wrote ${outputPath} (${source.length} characters)`);
