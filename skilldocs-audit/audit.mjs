import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE_URL = new URL(process.env.BASE_URL || 'https://skilldocs.pl/');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'skilldocs-audit/output');
const SUBMIT_FORMS = /^(1|true|yes)$/i.test(process.env.SUBMIT_FORMS || 'false');
const TEST_PHONE = process.env.TEST_PHONE || '+48570804478';
const TEST_EMAIL = process.env.TEST_EMAIL || 'contact@skilldocs.pl';
const MAX_URLS = Number.parseInt(process.env.MAX_URLS || '750', 10);
const MAX_FORM_SUBMISSIONS = Number.parseInt(process.env.MAX_FORM_SUBMISSIONS || '80', 10);
const PAGE_TIMEOUT_MS = Number.parseInt(process.env.PAGE_TIMEOUT_MS || '30000', 10);
const ACTION_TIMEOUT_MS = Number.parseInt(process.env.ACTION_TIMEOUT_MS || '7000', 10);
const AUDIT_ID = process.env.AUDIT_ID || `SD-AUDIT-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
const USER_AGENT = 'SKILLDOCS-QA-Audit/1.0 (+https://skilldocs.pl)';

const expectedMasterPopupByLanguage = {
  uk: '35414',
  en: '35415',
  pl: '35416',
};

const assetExtensionRe = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|mpeg|ogg|otf|pdf|png|pptx?|rar|rss|svg|tar|tiff?|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)(?:$|\?)/i;
const excludedPathRe = /\/(?:wp-admin|wp-login\.php|wp-json|wp-content|wp-includes|feed|comments|author|tag|category|elementor_library|cost-calc-templates)(?:\/|$)/i;
const nonUserSitemapRe = /(?:attachment|author|category|post_tag|elementor_library|cost-calc|product_cat|product_tag|portfolio-category|nav_menu|e-landing-page)[^/]*-sitemap/i;
const popupSelectors = [
  '.elementor-popup-modal:visible',
  '[role="dialog"]:visible',
  '[aria-modal="true"]:visible',
  '.mfp-wrap:visible',
  '.modal.show:visible',
  '.wd-popup:visible',
  '.pum-overlay:visible',
];
const successTextRe = /(thank|success|sent|submitted|received|dziękuj|wysłan|został wysłany|успеш|отправлен|дяку|надіслан|отриман)/i;
const errorTextRe = /(error|failed|invalid|błąd|nie udało|ошиб|не удалось|помилк|не вдалося)/i;

const state = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL.href,
  auditId: AUDIT_ID,
  submitForms: SUBMIT_FORMS,
  discovery: {
    sitemapCandidates: [],
    sitemapDocuments: [],
    fallbackCrawlUsed: false,
    discoveredUrls: 0,
    truncated: false,
  },
  pages: [],
  buttons: [],
  forms: [],
  links: [],
  globalErrors: [],
  submittedFormSignatures: new Map(),
  formSubmissionCount: 0,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function languageForUrl(url) {
  const pathname = new URL(url).pathname;
  if (pathname === '/uk/' || pathname.startsWith('/uk/')) return 'uk';
  if (pathname === '/en/' || pathname.startsWith('/en/')) return 'en';
  if (pathname === '/pl/' || pathname.startsWith('/pl/')) return 'pl';
  return 'ru';
}

function sanitizeFilePart(value, max = 90) {
  const cleaned = String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return cleaned || 'root';
}

function normalizePublicUrl(raw, base = BASE_URL) {
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hostname.replace(/^www\./, '') !== BASE_URL.hostname.replace(/^www\./, '')) return null;
    url.hash = '';
    if (url.searchParams.has('elementor_library') || url.searchParams.has('preview') || url.searchParams.has('elementor-preview')) return null;
    url.search = '';
    if (assetExtensionRe.test(url.pathname)) return null;
    if (excludedPathRe.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (!url.pathname.endsWith('/') && !/\.[a-z0-9]{1,8}$/i.test(url.pathname)) url.pathname += '/';
    return url.href;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'ru,en;q=0.8,pl;q=0.7,uk;q=0.6',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverFromSitemaps() {
  const candidates = [
    new URL('/sitemap_index.xml', BASE_URL).href,
    new URL('/sitemap.xml', BASE_URL).href,
    new URL('/wp-sitemap.xml', BASE_URL).href,
  ];
  state.discovery.sitemapCandidates = candidates;

  const urls = new Map();
  const visitedSitemaps = new Set();
  const queue = candidates.map((url) => ({ url, source: 'candidate', depth: 0 }));

  while (queue.length > 0 && urls.size < MAX_URLS) {
    const item = queue.shift();
    if (!item || visitedSitemaps.has(item.url) || item.depth > 6) continue;
    visitedSitemaps.add(item.url);
    try {
      const response = await fetchWithTimeout(item.url, { headers: { accept: 'application/xml,text/xml,text/plain,*/*' } }, 25000);
      const text = await response.text();
      const isXml = /<(?:urlset|sitemapindex)\b/i.test(text);
      if (!response.ok || !isXml) {
        state.discovery.sitemapDocuments.push({ url: item.url, status: response.status, ok: false, reason: isXml ? 'HTTP error' : 'not sitemap XML' });
        continue;
      }
      const locs = [...text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeXmlEntities(m[1].trim()));
      state.discovery.sitemapDocuments.push({ url: item.url, status: response.status, ok: true, locs: locs.length });
      const isIndex = /<sitemapindex\b/i.test(text);
      for (const loc of locs) {
        if (urls.size >= MAX_URLS) break;
        let parsed;
        try { parsed = new URL(loc, item.url); } catch { continue; }
        if (isIndex || /\.xml(?:$|\?)/i.test(parsed.pathname)) {
          if (parsed.hostname.replace(/^www\./, '') === BASE_URL.hostname.replace(/^www\./, '') && !nonUserSitemapRe.test(parsed.pathname)) {
            queue.push({ url: parsed.href, source: item.url, depth: item.depth + 1 });
          }
          continue;
        }
        const normalized = normalizePublicUrl(parsed.href);
        if (!normalized) continue;
        if (!urls.has(normalized)) urls.set(normalized, { source: item.url });
      }
    } catch (error) {
      state.discovery.sitemapDocuments.push({ url: item.url, ok: false, reason: `${error.name}: ${error.message}` });
    }
  }

  if (urls.size >= MAX_URLS) state.discovery.truncated = true;
  return urls;
}

function extractHtmlLinks(html, sourceUrl) {
  const found = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    try { found.push(new URL(decodeXmlEntities(raw), sourceUrl).href); } catch { /* ignore */ }
  }
  return found;
}

async function fallbackCrawl() {
  state.discovery.fallbackCrawlUsed = true;
  const urls = new Map([[BASE_URL.href, { source: 'fallback-root' }]]);
  const queue = [BASE_URL.href];
  const visited = new Set();
  while (queue.length > 0 && urls.size < MAX_URLS) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      const response = await fetchWithTimeout(url, { headers: { accept: 'text/html,*/*' } }, 20000);
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.includes('text/html')) continue;
      const html = await response.text();
      for (const href of extractHtmlLinks(html, url)) {
        const normalized = normalizePublicUrl(href);
        if (!normalized || urls.has(normalized)) continue;
        urls.set(normalized, { source: url });
        queue.push(normalized);
        if (urls.size >= MAX_URLS) break;
      }
    } catch (error) {
      state.globalErrors.push(`Fallback crawl ${url}: ${error.message}`);
    }
  }
  if (urls.size >= MAX_URLS) state.discovery.truncated = true;
  return urls;
}

async function dismissCommonOverlays(page) {
  const textCandidates = [
    /accept all/i, /accept/i, /allow all/i, /zgadzam/i, /akceptuj/i, /zaakceptuj/i,
    /принять/i, /принимаю/i, /дозволити/i, /прийняти/i,
  ];
  for (const pattern of textCandidates) {
    try {
      const locator = page.getByRole('button', { name: pattern }).first();
      if (await locator.isVisible({ timeout: 250 })) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(150);
        break;
      }
    } catch { /* ignore */ }
  }
}

async function initialPageSnapshot(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const cssPath = (el) => {
      if (!(el instanceof Element)) return '';
      if (el.id && /^[A-Za-z][\w:.-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        const stableAttrs = ['data-id', 'data-elementor-id', 'name', 'aria-controls'];
        let attrAdded = false;
        for (const attr of stableAttrs) {
          const val = current.getAttribute(attr);
          if (val && val.length < 100) {
            part += `[${attr}="${CSS.escape(val)}"]`;
            attrAdded = true;
            break;
          }
        }
        if (!attrAdded) {
          const siblings = current.parentElement ? [...current.parentElement.children].filter((x) => x.tagName === current.tagName) : [];
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = current.parentElement;
        if (parts.length >= 7) break;
      }
      return parts.join(' > ');
    };
    const cleanText = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const candidateSelector = [
      'button', 'input[type="button"]', 'input[type="submit"]', '[role="button"]',
      'a[href^="#"]', 'a[href^="javascript:"]', 'a[href*="elementor-action"]',
      '[data-elementor-open-lightbox]', '[data-e-action-hash]', '[onclick]',
      '.elementor-button', '.popup-trigger-btn', '.sd-open-native-popup', '.sd-native-popup-trigger',
      '[aria-controls]', '[aria-expanded]', '[data-bs-toggle]', '[data-toggle]'
    ].join(',');
    const candidates = [...document.querySelectorAll(candidateSelector)].map((el, index) => {
      const form = el.closest('form');
      const href = el.getAttribute('href') || '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const classes = [...el.classList].slice(0, 20).join(' ');
      const rect = el.getBoundingClientRect();
      return {
        index,
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        type,
        text: cleanText(el),
        href,
        classes,
        id: el.id || '',
        role: el.getAttribute('role') || '',
        ariaControls: el.getAttribute('aria-controls') || '',
        ariaExpanded: el.getAttribute('aria-expanded') || '',
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
        visible: isVisible(el),
        formId: form?.id || '',
        formClass: form?.className || '',
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        dataAction: el.getAttribute('data-e-action-hash') || el.getAttribute('data-elementor-open-lightbox') || '',
        onclick: el.getAttribute('onclick') || '',
      };
    });
    const links = [...document.querySelectorAll('a[href]')].map((el) => ({
      href: el.href,
      rawHref: el.getAttribute('href') || '',
      text: cleanText(el),
      selector: cssPath(el),
      visible: isVisible(el),
      target: el.getAttribute('target') || '',
      rel: el.getAttribute('rel') || '',
    }));
    const forms = [...document.querySelectorAll('form')].map((form) => ({
      selector: cssPath(form),
      id: form.id || '',
      className: form.className || '',
      action: form.action || '',
      method: form.method || '',
      visible: isVisible(form),
      fields: [...form.querySelectorAll('input,select,textarea')].map((f) => ({
        tag: f.tagName.toLowerCase(),
        type: (f.getAttribute('type') || '').toLowerCase(),
        name: f.getAttribute('name') || '',
        id: f.id || '',
        required: f.required || f.getAttribute('aria-required') === 'true',
        value: ['hidden', 'submit', 'button'].includes((f.getAttribute('type') || '').toLowerCase()) ? (f.value || '').slice(0, 180) : '',
        accept: f.getAttribute('accept') || '',
      })),
      submitText: cleanText(form.querySelector('button[type="submit"],input[type="submit"],button:not([type])') || form),
    }));
    const html = document.documentElement;
    return {
      lang: html.lang || '',
      title: document.title,
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      h1: [...document.querySelectorAll('h1')].map((h) => cleanText(h)).filter(Boolean),
      candidates,
      links,
      forms,
      viewport: { width: innerWidth, height: innerHeight },
      documentSize: { width: html.scrollWidth, height: html.scrollHeight },
      horizontalOverflow: html.scrollWidth > innerWidth + 4,
    };
  });
}

function candidateShouldBeInteractionTested(candidate) {
  if (!candidate.visible || candidate.disabled) return false;
  if (candidate.tag === 'input' && ['submit', 'reset'].includes(candidate.type)) return false;
  if (candidate.formId || /\b(form|wpcf7|wpforms)\b/i.test(candidate.formClass)) {
    if (candidate.type === 'submit' || /submit|send|отправ|wys|надісл/i.test(candidate.text)) return false;
  }
  if (/cookie|consent|cky-|cmplz|complianz/i.test(`${candidate.classes} ${candidate.id}`)) return false;
  const href = candidate.href.trim();
  if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !href.includes('elementor-action')) return false;
  if (candidate.tag === 'a' && !href && !candidate.onclick && !candidate.dataAction && !candidate.ariaControls) return false;
  return true;
}

async function getVisiblePopupInfo(page) {
  for (const selector of popupSelectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 80 })) {
        const info = await locator.evaluate((el) => {
          const root = el.matches('[data-elementor-id]') ? el : el.querySelector('[data-elementor-id]');
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
          return {
            selector: el.className ? `.${String(el.className).trim().split(/\s+/).slice(0, 4).join('.')}` : el.tagName.toLowerCase(),
            popupId: root?.getAttribute('data-elementor-id') || el.getAttribute('data-elementor-id') || '',
            text,
          };
        });
        return info;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function closeVisiblePopups(page) {
  const closeSelectors = [
    '.dialog-close-button:visible', '.elementor-popup-modal .dialog-close-button:visible',
    '[aria-label*="Close" i]:visible', '[aria-label*="Закры" i]:visible', '[aria-label*="Zamkn" i]:visible',
    '.mfp-close:visible', '.modal.show [data-bs-dismiss="modal"]:visible', '.pum-close:visible',
  ];
  for (const selector of closeSelectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 80 })) {
        await locator.click({ timeout: 800 });
        await page.waitForTimeout(120);
      }
    } catch { /* ignore */ }
  }
  try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
}

async function testCandidate(page, pageUrl, candidate, viewportName) {
  const result = {
    pageUrl,
    viewport: viewportName,
    selector: candidate.selector,
    text: candidate.text,
    tag: candidate.tag,
    href: candidate.href,
    classes: candidate.classes,
    visible: candidate.visible,
    disabled: candidate.disabled,
    status: 'not-tested',
    effect: '',
    popupId: '',
    popupText: '',
    expectedMasterPopupId: expectedMasterPopupByLanguage[languageForUrl(pageUrl)] || '',
    masterPopupMatch: '',
    error: '',
  };
  const locator = page.locator(candidate.selector).first();
  try {
    if (!(await locator.count())) {
      result.status = 'error';
      result.error = 'Element not found by stable selector';
      return result;
    }
    if (!(await locator.isVisible({ timeout: 500 }))) {
      result.status = 'not-visible';
      return result;
    }
    await closeVisiblePopups(page);
    await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const before = await locator.evaluate((el) => ({
      url: location.href,
      expanded: el.getAttribute('aria-expanded') || '',
      controlledVisible: (() => {
        const id = el.getAttribute('aria-controls');
        if (!id) return null;
        const target = document.getElementById(id);
        if (!target) return null;
        const s = getComputedStyle(target); const r = target.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      })(),
      scrollY,
    }));
    await page.evaluate(() => {
      window.__sdAuditMutations = 0;
      window.__sdAuditObserver?.disconnect?.();
      window.__sdAuditObserver = new MutationObserver((records) => { window.__sdAuditMutations += records.length; });
      window.__sdAuditObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    });

    await locator.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
    await page.waitForTimeout(900);

    const popup = await getVisiblePopupInfo(page);
    const after = await locator.evaluate((el) => ({
      url: location.href,
      expanded: el.getAttribute('aria-expanded') || '',
      controlledVisible: (() => {
        const id = el.getAttribute('aria-controls');
        if (!id) return null;
        const target = document.getElementById(id);
        if (!target) return null;
        const s = getComputedStyle(target); const r = target.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      })(),
      scrollY,
      mutations: window.__sdAuditMutations || 0,
    })).catch(() => ({ url: page.url(), expanded: '', controlledVisible: null, scrollY: 0, mutations: 0 }));

    if (popup) {
      result.status = 'ok';
      result.effect = 'popup-opened';
      result.popupId = popup.popupId;
      result.popupText = popup.text;
      if (result.expectedMasterPopupId && /popup-trigger-btn|sd-open-native-popup|sd-native-popup-trigger/i.test(candidate.classes)) {
        result.masterPopupMatch = popup.popupId === result.expectedMasterPopupId ? 'yes' : 'no';
      }
    } else if (after.url !== before.url) {
      result.status = 'ok';
      result.effect = `navigation:${after.url}`;
    } else if (after.expanded !== before.expanded && after.expanded) {
      result.status = 'ok';
      result.effect = `aria-expanded:${before.expanded}->${after.expanded}`;
    } else if (after.controlledVisible !== before.controlledVisible && after.controlledVisible !== null) {
      result.status = 'ok';
      result.effect = `controlled-visibility:${before.controlledVisible}->${after.controlledVisible}`;
    } else if (Math.abs((after.scrollY || 0) - (before.scrollY || 0)) > 40) {
      result.status = 'ok';
      result.effect = 'scroll-or-anchor';
    } else if ((after.mutations || 0) > 0) {
      result.status = 'ok';
      result.effect = `dom-mutated:${after.mutations}`;
    } else {
      result.status = 'no-effect';
      result.effect = 'no observable response';
    }
  } catch (error) {
    result.status = 'error';
    result.error = `${error.name}: ${error.message}`.slice(0, 600);
  }
  return result;
}

function formLooksLikeLeadForm(form) {
  const haystack = `${form.id} ${form.className} ${form.action} ${form.fields.map((f) => `${f.name} ${f.type}`).join(' ')}`.toLowerCase();
  if (/searchform|woocommerce-product-search|\bsearch\b|wp-login|commentform|newsletter|mailpoet|mc4wp|login|register/.test(haystack)) return false;
  if (/elementor-form|wpcf7|wpforms|forminator|fluentform|gravityform|ninja/.test(haystack)) return true;
  return form.fields.some((f) => f.type === 'tel' || /phone|tel|telefon/.test(f.name)) && form.fields.some((f) => /name|first|имя|imi|name/.test(f.name));
}

function formSignature(form, pageLanguage, popupId = '') {
  const hiddenIds = form.fields
    .filter((f) => f.type === 'hidden' && /(?:form|wpcf7|wpforms|id|post)/i.test(f.name))
    .map((f) => `${f.name}=${f.value}`)
    .sort();
  const fieldShape = form.fields.map((f) => `${f.tag}:${f.type}:${f.name}:${f.required ? 1 : 0}`).sort();
  const raw = JSON.stringify({ pageLanguage, popupId, id: form.id, className: form.className, action: form.action, hiddenIds, fieldShape });
  return sha1(raw);
}

async function ensureAuditUploadFixtures() {
  const fixtures = path.join(OUTPUT_DIR, 'fixtures');
  await fs.mkdir(fixtures, { recursive: true });
  const txt = path.join(fixtures, 'audit-test.txt');
  const png = path.join(fixtures, 'audit-test.png');
  const pdf = path.join(fixtures, 'audit-test.pdf');
  await fs.writeFile(txt, `${AUDIT_ID}\nAutomated QA test file. Please delete.\n`, 'utf8');
  await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'));
  const pdfData = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (SKILLDOCS QA TEST) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer<</Root 1 0 R/Size 5>>\nstartxref\n0\n%%EOF\n';
  await fs.writeFile(pdf, pdfData, 'binary');
  return { txt, png, pdf };
}

async function describeForms(page, popupId = '') {
  return await page.evaluate((popupIdArg) => {
    const isVisible = (el) => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const cssPath = (el) => {
      if (el.id && /^[A-Za-z][\w:.-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
      const parts = []; let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        let p = cur.tagName.toLowerCase();
        const siblings = cur.parentElement ? [...cur.parentElement.children].filter((x) => x.tagName === cur.tagName) : [];
        if (siblings.length > 1) p += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        parts.unshift(p); cur = cur.parentElement; if (parts.length >= 7) break;
      }
      return parts.join(' > ');
    };
    const root = popupIdArg ? document.querySelector(`.elementor-popup-modal:visible [data-elementor-id="${CSS.escape(popupIdArg)}"]`)?.closest('.elementor-popup-modal') || document : document;
    return [...root.querySelectorAll('form')].map((form) => ({
      selector: cssPath(form), id: form.id || '', className: form.className || '', action: form.action || '', method: form.method || '', visible: isVisible(form),
      fields: [...form.querySelectorAll('input,select,textarea')].map((f) => ({
        tag: f.tagName.toLowerCase(), type: (f.getAttribute('type') || '').toLowerCase(), name: f.getAttribute('name') || '', id: f.id || '', required: f.required || f.getAttribute('aria-required') === 'true', value: ['hidden','submit','button'].includes((f.getAttribute('type') || '').toLowerCase()) ? (f.value || '').slice(0, 180) : '', accept: f.getAttribute('accept') || '',
      })),
      submitText: ((form.querySelector('button[type="submit"],input[type="submit"],button:not([type])')?.innerText || form.querySelector('input[type="submit"]')?.value || '').replace(/\s+/g, ' ').trim()),
    }));
  }, popupId);
}

async function fillLeadForm(page, formSelector, sequence, fixtures) {
  const form = page.locator(formSelector).first();
  const marker = `${AUDIT_ID}-F${String(sequence).padStart(3, '0')}`;
  const pageUrl = page.url();
  const inputs = form.locator('input,select,textarea');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const field = inputs.nth(i);
    try {
      const meta = await field.evaluate((el) => ({
        tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), name: (el.getAttribute('name') || '').toLowerCase(), id: (el.id || '').toLowerCase(), placeholder: (el.getAttribute('placeholder') || '').toLowerCase(), required: el.required || el.getAttribute('aria-required') === 'true', disabled: el.disabled, readonly: el.readOnly, accept: el.getAttribute('accept') || '', value: el.value || '', checked: el.checked || false,
      }));
      if (meta.disabled || meta.readonly || ['hidden', 'submit', 'button', 'reset', 'image'].includes(meta.type)) continue;
      const key = `${meta.name} ${meta.id} ${meta.placeholder}`;
      if (meta.type === 'checkbox') {
        if (meta.required || /consent|privacy|policy|zgod|agree|rodo|accept/.test(key)) await field.check({ force: true });
        continue;
      }
      if (meta.type === 'radio') {
        const radioName = await field.getAttribute('name');
        if (radioName) {
          const group = form.locator(`input[type="radio"][name="${radioName.replace(/"/g, '\\"')}"]`);
          if (await group.count()) await group.first().check({ force: true });
        }
        continue;
      }
      if (meta.type === 'file') {
        const accept = meta.accept.toLowerCase();
        const filePath = accept.includes('image') || /png|jpg|jpeg/.test(accept) ? fixtures.png : accept.includes('pdf') ? fixtures.pdf : fixtures.txt;
        await field.setInputFiles(filePath);
        continue;
      }
      if (meta.tag === 'select') {
        const options = await field.locator('option').evaluateAll((opts) => opts.map((o) => ({ value: o.value, disabled: o.disabled, text: o.textContent || '' })));
        const option = options.find((o) => !o.disabled && o.value && !/select|wybierz|выберите|оберіть|choose/i.test(o.text));
        if (option) await field.selectOption(option.value);
        continue;
      }
      if (meta.tag === 'textarea') {
        await field.fill(`AUTOMATED TEST - PLEASE DELETE. ${marker}. Source: ${pageUrl}`);
        continue;
      }
      if (meta.type === 'tel' || /phone|tel|telefon|телефон/.test(key)) {
        await field.fill(TEST_PHONE);
      } else if (meta.type === 'email' || /email|e-mail|mail/.test(key)) {
        await field.fill(TEST_EMAIL);
      } else if (/name|first|имя|imię|imie|ім.?я|fname/.test(key)) {
        await field.fill(`TEST SITE AUDIT ${marker}`);
      } else if (/surname|last|фамил|nazwisko|прізвищ/.test(key)) {
        await field.fill('DELETE');
      } else if (/city|miasto|город|місто/.test(key)) {
        await field.fill('Warszawa');
      } else if (/postal|zip|kod/.test(key)) {
        await field.fill('02-697');
      } else if (/date|data|дата/.test(key) || meta.type === 'date') {
        await field.fill('2026-07-31');
      } else if (/budget|amount|price|kwot|cena|бюджет|сумм/.test(key) || meta.type === 'number') {
        await field.fill('1000');
      } else if (/url|website|site/.test(key) || meta.type === 'url') {
        await field.fill(pageUrl);
      } else if (meta.required && !meta.value) {
        await field.fill(`TEST ${marker}`);
      }
    } catch (error) {
      log('Field fill warning', formSelector, i, error.message);
    }
  }
  return marker;
}

async function submitForm(page, pageRecord, formInfo, popupId, viewportName, fixtures) {
  const pageLanguage = languageForUrl(page.url());
  const signature = formSignature(formInfo, pageLanguage, popupId);
  const record = {
    pageUrl: page.url(), viewport: viewportName, popupId, formSelector: formInfo.selector, formId: formInfo.id, formClass: formInfo.className, action: formInfo.action,
    signature, visible: formInfo.visible, leadForm: formLooksLikeLeadForm(formInfo), submitted: false, deduplicated: false, marker: '', status: 'inspected', frontendMessage: '', network: [], error: '',
  };
  if (!record.leadForm) {
    record.status = 'excluded-non-lead-form';
    return record;
  }
  if (!formInfo.visible) {
    record.status = 'hidden-not-submitted';
    return record;
  }
  if (!SUBMIT_FORMS) {
    record.status = 'submission-disabled';
    return record;
  }
  if (state.submittedFormSignatures.has(signature)) {
    record.status = 'deduplicated';
    record.deduplicated = true;
    record.marker = state.submittedFormSignatures.get(signature).marker;
    return record;
  }
  if (state.formSubmissionCount >= MAX_FORM_SUBMISSIONS) {
    record.status = 'submission-cap-reached';
    return record;
  }
  const form = page.locator(formInfo.selector).first();
  try {
    if (!(await form.isVisible({ timeout: 1000 }))) {
      record.status = 'not-visible-at-submit';
      return record;
    }
    state.formSubmissionCount += 1;
    const marker = await fillLeadForm(page, formInfo.selector, state.formSubmissionCount, fixtures);
    record.marker = marker;

    const captured = [];
    const responseHandler = async (response) => {
      const u = response.url();
      if (/admin-ajax|wp-json|elementor|wpcf7|wpforms|forminator|fluent|bitrix|webhook|crm/i.test(u)) {
        let body = '';
        try {
          const ct = response.headers()['content-type'] || '';
          if (/json|text|html/.test(ct)) body = (await response.text()).slice(0, 2000);
        } catch { /* ignore */ }
        captured.push({ url: u, status: response.status(), method: response.request().method(), body });
      }
    };
    page.on('response', responseHandler);
    const submitCandidates = form.locator('button[type="submit"],input[type="submit"],button:not([type])');
    let submit = null;
    const submitCount = await submitCandidates.count();
    for (let i = 0; i < submitCount; i += 1) {
      const candidate = submitCandidates.nth(i);
      if (await candidate.isVisible().catch(() => false)) { submit = candidate; break; }
    }
    if (!submit) throw new Error('Visible submit control not found');
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click({ timeout: ACTION_TIMEOUT_MS, noWaitAfter: true });
    await page.waitForTimeout(6500);
    page.off('response', responseHandler);
    record.network = captured;
    record.submitted = true;

    const message = await form.evaluate((el) => {
      const selectors = ['.elementor-message', '.wpcf7-response-output', '.wpforms-confirmation-container', '.wpforms-error-container', '[role="alert"]', '.forminator-response-message', '.ff-message-success'];
      const texts = [];
      for (const selector of selectors) {
        for (const node of el.querySelectorAll(selector)) {
          const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) texts.push(t);
        }
      }
      return texts.join(' | ').slice(0, 1200);
    }).catch(() => '');
    record.frontendMessage = message;

    const networkOkay = captured.some((r) => r.status >= 200 && r.status < 400 && !errorTextRe.test(r.body));
    const networkError = captured.some((r) => r.status >= 400 || errorTextRe.test(r.body));
    if ((message && successTextRe.test(message)) || networkOkay) {
      record.status = networkError && !successTextRe.test(message) ? 'submitted-with-network-error' : 'accepted-by-site';
    } else if (message && errorTextRe.test(message)) {
      record.status = 'frontend-error';
    } else if (captured.length === 0) {
      record.status = 'no-submit-request-observed';
    } else {
      record.status = 'submitted-unconfirmed';
    }
    state.submittedFormSignatures.set(signature, { marker, status: record.status, pageUrl: record.pageUrl });
  } catch (error) {
    record.status = 'submit-error';
    record.error = `${error.name}: ${error.message}`.slice(0, 1000);
    state.submittedFormSignatures.set(signature, { marker: record.marker, status: record.status, pageUrl: record.pageUrl });
  }
  return record;
}

async function collectVisibleFormsAfterCandidate(page, pageRecord, buttonResult, viewportName, fixtures) {
  if (buttonResult.status !== 'ok') return [];
  const popupId = buttonResult.effect === 'popup-opened' ? buttonResult.popupId : '';
  const forms = await describeForms(page, popupId);
  const records = [];
  for (const formInfo of forms) {
    if (!formInfo.visible) continue;
    records.push(await submitForm(page, pageRecord, formInfo, popupId, viewportName, fixtures));
  }
  return records;
}

async function auditViewport(browser, url, source, viewportName, contextOptions, exhaustiveInteractions, fixtures) {
  const context = await browser.newContext({
    ...contextOptions,
    userAgent: USER_AGENT,
    locale: viewportName === 'desktop' ? 'ru-RU' : 'pl-PL',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 1000)); });
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`.slice(0, 1000)));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), reason: request.failure()?.errorText || '' }));

  const pageRecord = {
    url, source, viewport: viewportName, finalUrl: '', status: 0, ok: false, title: '', lang: '', h1: [], canonical: '',
    horizontalOverflow: false, documentWidth: 0, viewportWidth: 0,
    links: 0, buttons: 0, forms: 0, interactionCandidates: 0, interactionsTested: 0, interactionsOk: 0, interactionsFailed: 0,
    inlineFormsInspected: 0, consoleErrors, pageErrors, failedRequests, screenshot: '', error: '',
  };

  try {
    log(`[${viewportName}] ${url}`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    pageRecord.status = response?.status() || 0;
    pageRecord.finalUrl = page.url();
    pageRecord.ok = Boolean(response && response.status() >= 200 && response.status() < 400);
    await page.waitForTimeout(1000);
    await dismissCommonOverlays(page);
    const snapshot = await initialPageSnapshot(page);
    pageRecord.title = snapshot.title;
    pageRecord.lang = snapshot.lang;
    pageRecord.h1 = snapshot.h1;
    pageRecord.canonical = snapshot.canonical;
    pageRecord.horizontalOverflow = snapshot.horizontalOverflow;
    pageRecord.documentWidth = snapshot.documentSize.width;
    pageRecord.viewportWidth = snapshot.viewport.width;
    pageRecord.links = snapshot.links.length;
    pageRecord.buttons = snapshot.candidates.length;
    pageRecord.forms = snapshot.forms.length;

    for (const link of snapshot.links) {
      state.links.push({ sourceUrl: url, viewport: viewportName, ...link });
    }

    const interactionCandidates = snapshot.candidates.filter(candidateShouldBeInteractionTested);
    pageRecord.interactionCandidates = interactionCandidates.length;
    const selectedCandidates = exhaustiveInteractions
      ? interactionCandidates
      : interactionCandidates.filter((c) => /popup|elementor-action|menu|nav|accordion|tab|sd-open|popup-trigger/i.test(`${c.href} ${c.classes} ${c.dataAction}`) || Boolean(c.ariaControls) || Boolean(c.ariaExpanded)).slice(0, 16);

    for (const candidate of selectedCandidates) {
      const result = await testCandidate(page, url, candidate, viewportName);
      state.buttons.push(result);
      pageRecord.interactionsTested += 1;
      if (result.status === 'ok') pageRecord.interactionsOk += 1;
      if (['no-effect', 'error', 'not-visible'].includes(result.status)) pageRecord.interactionsFailed += 1;
      if (viewportName === 'desktop' && result.status === 'ok') {
        const visibleFormRecords = await collectVisibleFormsAfterCandidate(page, pageRecord, result, viewportName, fixtures);
        state.forms.push(...visibleFormRecords);
      }
      await closeVisiblePopups(page);
      if (page.url() !== pageRecord.finalUrl) {
        await page.goto(pageRecord.finalUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(400);
        await dismissCommonOverlays(page);
      }
    }

    if (viewportName === 'desktop') {
      for (const formInfo of snapshot.forms) {
        const formRecord = await submitForm(page, pageRecord, formInfo, '', viewportName, fixtures);
        state.forms.push(formRecord);
        pageRecord.inlineFormsInspected += 1;
      }
    }

    if (!pageRecord.ok || pageRecord.interactionsFailed > 0 || pageRecord.horizontalOverflow || consoleErrors.length || pageErrors.length) {
      const filename = `${sanitizeFilePart(new URL(url).pathname)}-${viewportName}-${sha1(url).slice(0, 8)}.png`;
      const screenshotPath = path.join(OUTPUT_DIR, 'screenshots', filename);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      pageRecord.screenshot = path.relative(OUTPUT_DIR, screenshotPath);
    }
  } catch (error) {
    pageRecord.error = `${error.name}: ${error.message}`.slice(0, 1500);
    pageRecord.ok = false;
    try {
      const filename = `${sanitizeFilePart(new URL(url).pathname)}-${viewportName}-fatal-${sha1(url).slice(0, 8)}.png`;
      const screenshotPath = path.join(OUTPUT_DIR, 'screenshots', filename);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      pageRecord.screenshot = path.relative(OUTPUT_DIR, screenshotPath);
    } catch { /* ignore */ }
  } finally {
    state.pages.push(pageRecord);
    await context.close();
  }
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

function normalizeLinkTarget(rawHref, sourceUrl) {
  if (!rawHref) return { kind: 'empty', target: '' };
  const trimmed = rawHref.trim();
  if (trimmed.startsWith('#')) return { kind: 'fragment', target: trimmed };
  if (/^javascript:/i.test(trimmed)) return { kind: 'javascript', target: trimmed };
  if (/^mailto:/i.test(trimmed)) return { kind: 'mailto', target: trimmed };
  if (/^tel:/i.test(trimmed)) return { kind: 'tel', target: trimmed };
  try {
    const url = new URL(trimmed, sourceUrl);
    return { kind: ['http:', 'https:'].includes(url.protocol) ? 'http' : url.protocol.replace(':', ''), target: url.href };
  } catch {
    return { kind: 'invalid', target: trimmed };
  }
}

async function validateUniqueLinks() {
  const unique = new Map();
  for (const link of state.links) {
    const normalized = normalizeLinkTarget(link.rawHref || link.href, link.sourceUrl);
    const key = `${normalized.kind}|${normalized.target}`;
    if (!unique.has(key)) unique.set(key, { ...normalized, sources: [], texts: [] });
    const entry = unique.get(key);
    if (entry.sources.length < 6) entry.sources.push(link.sourceUrl);
    if (link.text && entry.texts.length < 6) entry.texts.push(link.text);
  }

  const results = [];
  const entries = [...unique.values()];
  await runPool(entries, 10, async (entry) => {
    const result = { ...entry, status: '', httpStatus: 0, finalUrl: '', error: '' };
    if (entry.kind === 'empty') result.status = 'empty-href';
    else if (entry.kind === 'invalid') result.status = 'invalid-url';
    else if (entry.kind === 'fragment' || entry.kind === 'javascript') result.status = 'interaction-only';
    else if (entry.kind === 'mailto') result.status = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+/i.test(entry.target) ? 'syntax-ok' : 'invalid-mailto';
    else if (entry.kind === 'tel') result.status = /^tel:\+?[0-9() .-]{6,}$/i.test(entry.target) ? 'syntax-ok' : 'invalid-tel';
    else if (entry.kind === 'http') {
      try {
        let response = await fetchWithTimeout(entry.target, { method: 'HEAD', headers: { accept: '*/*' } }, 18000);
        if ([405, 501].includes(response.status)) response = await fetchWithTimeout(entry.target, { method: 'GET', headers: { range: 'bytes=0-1024', accept: '*/*' } }, 18000);
        result.httpStatus = response.status;
        result.finalUrl = response.url;
        if (response.status >= 200 && response.status < 400) result.status = 'ok';
        else if ([401, 403, 406, 418, 429].includes(response.status)) result.status = 'blocked-or-unverified';
        else result.status = 'http-error';
        try { await response.body?.cancel(); } catch { /* ignore */ }
      } catch (error) {
        result.status = 'request-error';
        result.error = `${error.name}: ${error.message}`.slice(0, 500);
      }
    } else result.status = 'not-http';
    results.push(result);
  });
  state.links = results.sort((a, b) => a.status.localeCompare(b.status) || a.target.localeCompare(b.target));
}

function csvEscape(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsv(file, rows, columns) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function summarize() {
  const desktopPages = state.pages.filter((p) => p.viewport === 'desktop');
  const mobilePages = state.pages.filter((p) => p.viewport === 'mobile');
  const uniquePageUrls = new Set(desktopPages.map((p) => p.url));
  const brokenPages = desktopPages.filter((p) => !p.ok || p.error);
  const brokenButtons = state.buttons.filter((b) => ['no-effect', 'error', 'not-visible'].includes(b.status));
  const popupButtons = state.buttons.filter((b) => b.effect === 'popup-opened');
  const popupMasterMismatches = state.buttons.filter((b) => b.masterPopupMatch === 'no');
  const leadForms = state.forms.filter((f) => f.leadForm);
  const submitted = state.forms.filter((f) => f.submitted);
  const accepted = submitted.filter((f) => f.status === 'accepted-by-site');
  const formFailures = state.forms.filter((f) => ['submit-error', 'frontend-error', 'no-submit-request-observed', 'submitted-with-network-error'].includes(f.status));
  const badLinks = state.links.filter((l) => ['empty-href', 'invalid-url', 'invalid-mailto', 'invalid-tel', 'http-error', 'request-error'].includes(l.status));
  const internalBadLinks = badLinks.filter((l) => {
    try { return new URL(l.target).hostname.replace(/^www\./, '') === BASE_URL.hostname.replace(/^www\./, ''); } catch { return false; }
  });
  return {
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    auditId: AUDIT_ID,
    baseUrl: BASE_URL.href,
    submitForms: SUBMIT_FORMS,
    discoveredUrls: state.discovery.discoveredUrls,
    uniquePageUrls: uniquePageUrls.size,
    desktopPagesAudited: desktopPages.length,
    mobilePagesAudited: mobilePages.length,
    pagesHttpOrLoadFailed: brokenPages.length,
    buttonsInspected: state.buttons.length,
    buttonsWorking: state.buttons.filter((b) => b.status === 'ok').length,
    buttonsFailedOrNoEffect: brokenButtons.length,
    popupsOpened: popupButtons.length,
    masterPopupMismatches: popupMasterMismatches.length,
    formsObserved: state.forms.length,
    leadFormsObserved: leadForms.length,
    uniqueLeadFormsSubmitted: submitted.length,
    formsAcceptedBySite: accepted.length,
    formFailures: formFailures.length,
    uniqueLinksChecked: state.links.length,
    badLinks: badLinks.length,
    badInternalLinks: internalBadLinks.length,
    pagesWithHorizontalOverflowDesktop: desktopPages.filter((p) => p.horizontalOverflow).length,
    pagesWithHorizontalOverflowMobile: mobilePages.filter((p) => p.horizontalOverflow).length,
    pagesWithConsoleErrors: state.pages.filter((p) => p.consoleErrors.length || p.pageErrors.length).length,
    actualBitrixArrivalVerified: false,
    bitrixCaveat: 'The public browser audit can confirm front-end behavior and server acceptance. It cannot independently inspect Bitrix CRM records without CRM access.',
  };
}

async function writeReports() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const summary = summarize();
  const serializable = {
    ...state,
    submittedFormSignatures: Object.fromEntries(state.submittedFormSignatures.entries()),
    summary,
  };
  await fs.writeFile(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'audit.json'), JSON.stringify(serializable, null, 2), 'utf8');
  await writeCsv(path.join(OUTPUT_DIR, 'pages.csv'), state.pages, ['url','source','viewport','finalUrl','status','ok','title','lang','h1','canonical','horizontalOverflow','documentWidth','viewportWidth','links','buttons','forms','interactionCandidates','interactionsTested','interactionsOk','interactionsFailed','inlineFormsInspected','consoleErrors','pageErrors','failedRequests','screenshot','error']);
  await writeCsv(path.join(OUTPUT_DIR, 'buttons.csv'), state.buttons, ['pageUrl','viewport','selector','text','tag','href','classes','visible','disabled','status','effect','popupId','expectedMasterPopupId','masterPopupMatch','popupText','error']);
  await writeCsv(path.join(OUTPUT_DIR, 'forms.csv'), state.forms, ['pageUrl','viewport','popupId','formSelector','formId','formClass','action','signature','visible','leadForm','submitted','deduplicated','marker','status','frontendMessage','network','error']);
  await writeCsv(path.join(OUTPUT_DIR, 'links.csv'), state.links, ['kind','target','sources','texts','status','httpStatus','finalUrl','error']);

  const badButtons = state.buttons.filter((b) => ['no-effect','error','not-visible'].includes(b.status));
  const badForms = state.forms.filter((f) => ['submit-error','frontend-error','no-submit-request-observed','submitted-with-network-error','submitted-unconfirmed'].includes(f.status));
  const badLinks = state.links.filter((l) => ['empty-href','invalid-url','invalid-mailto','invalid-tel','http-error','request-error'].includes(l.status));
  const failedPages = state.pages.filter((p) => !p.ok || p.error);
  const popupMismatches = state.buttons.filter((b) => b.masterPopupMatch === 'no');

  const row = (cells) => `<tr>${cells.map((c) => `<td>${htmlEscape(c)}</td>`).join('')}</tr>`;
  const table = (headers, rows) => `<div class="table-wrap"><table><thead>${row(headers)}</thead><tbody>${rows.join('')}</tbody></table></div>`;
  const cards = Object.entries(summary).filter(([k]) => typeof summary[k] === 'number').map(([k, v]) => `<div class="card"><div class="n">${htmlEscape(v)}</div><div class="k">${htmlEscape(k)}</div></div>`).join('');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SKILLDOCS full-site audit ${htmlEscape(AUDIT_ID)}</title><style>
  body{font-family:Arial,sans-serif;margin:0;background:#f4f7fb;color:#13203a}.wrap{max-width:1500px;margin:auto;padding:28px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.card{background:#fff;border:1px solid #dfe6f0;border-radius:12px;padding:16px}.n{font-size:28px;font-weight:800}.k{font-size:12px;color:#52627a;margin-top:6px;word-break:break-word}.table-wrap{overflow:auto;background:#fff;border:1px solid #dfe6f0;border-radius:12px;margin:12px 0 30px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:9px;border-bottom:1px solid #e9eef5;vertical-align:top;text-align:left;max-width:500px;word-break:break-word}th{position:sticky;top:0;background:#eaf1fb}h1,h2{margin-top:28px}.note{background:#fff6d8;border:1px solid #eed27a;padding:14px;border-radius:10px}.ok{background:#e9f8ee;border-color:#8bd1a2}</style></head><body><div class="wrap">
  <h1>SKILLDOCS - полный аудит кнопок, попапов, форм и ссылок</h1><p>Audit ID: <b>${htmlEscape(AUDIT_ID)}</b><br>Started: ${htmlEscape(state.startedAt)}<br>Finished: ${htmlEscape(summary.finishedAt)}</p>
  <div class="note">Формы: ${SUBMIT_FORMS ? 'тестовые отправки разрешены и выполнены для уникальных конфигураций форм' : 'отправки отключены'}. Факт появления записи именно в Bitrix невозможно подтвердить из публичного браузера без доступа к CRM; в отчёте отдельно показаны фронтенд-ответы и сетевые ответы сайта.</div>
  <div class="cards">${cards}</div>
  <h2>Страницы с ошибкой загрузки/HTTP</h2>${table(['URL','viewport','HTTP','error','screenshot'], failedPages.map((p) => row([p.url,p.viewport,p.status,p.error,p.screenshot])))}
  <h2>Кнопки без подтверждённого действия</h2>${table(['Page','viewport','text','selector','status','effect','error'], badButtons.map((b) => row([b.pageUrl,b.viewport,b.text,b.selector,b.status,b.effect,b.error])))}
  <h2>Попапы с несовпадением master ID (предупреждение)</h2>${table(['Page','text','opened popup','expected','classes'], popupMismatches.map((b) => row([b.pageUrl,b.text,b.popupId,b.expectedMasterPopupId,b.classes])))}
  <h2>Ошибки/неподтверждённые отправки форм</h2>${table(['Page','popup','form','marker','status','message','network','error'], badForms.map((f) => row([f.pageUrl,f.popupId,f.formSelector,f.marker,f.status,f.frontendMessage,JSON.stringify(f.network),f.error])))}
  <h2>Неработающие или некорректные ссылки</h2>${table(['Target','status','HTTP','sources','error'], badLinks.map((l) => row([l.target,l.status,l.httpStatus,l.sources.join(' | '),l.error])))}
  <h2>Все формы</h2>${table(['Page','popup','signature','submitted','marker','status','message'], state.forms.map((f) => row([f.pageUrl,f.popupId,f.signature,f.submitted,f.marker,f.status,f.frontendMessage])))}
  <h2>Все страницы</h2>${table(['URL','viewport','HTTP','title','buttons tested','failed','forms','overflow','console errors'], state.pages.map((p) => row([p.url,p.viewport,p.status,p.title,p.interactionsTested,p.interactionsFailed,p.forms,p.horizontalOverflow,p.consoleErrors.length+p.pageErrors.length])))}
  </div></body></html>`;
  await fs.writeFile(path.join(OUTPUT_DIR, 'report.html'), html, 'utf8');

  const md = `# SKILLDOCS full-site audit\n\n- Audit ID: ${AUDIT_ID}\n- Started: ${state.startedAt}\n- Finished: ${summary.finishedAt}\n- URLs discovered: ${summary.discoveredUrls}\n- Desktop pages audited: ${summary.desktopPagesAudited}\n- Mobile pages audited: ${summary.mobilePagesAudited}\n- Buttons tested: ${summary.buttonsInspected}\n- Buttons failed/no effect: ${summary.buttonsFailedOrNoEffect}\n- Popups opened: ${summary.popupsOpened}\n- Forms observed: ${summary.formsObserved}\n- Unique forms submitted: ${summary.uniqueLeadFormsSubmitted}\n- Forms accepted by site: ${summary.formsAcceptedBySite}\n- Form failures: ${summary.formFailures}\n- Unique links checked: ${summary.uniqueLinksChecked}\n- Bad internal links: ${summary.badInternalLinks}\n\n## CRM limitation\n\n${summary.bitrixCaveat}\n`;
  await fs.writeFile(path.join(OUTPUT_DIR, 'README.md'), md, 'utf8');
  return summary;
}

async function main() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(OUTPUT_DIR, 'screenshots'), { recursive: true });
  const fixtures = await ensureAuditUploadFixtures();
  let urls = await discoverFromSitemaps();
  if (urls.size === 0) urls = await fallbackCrawl();
  if (!urls.has(BASE_URL.href)) urls.set(BASE_URL.href, { source: 'forced-root' });
  const entries = [...urls.entries()].slice(0, MAX_URLS).map(([url, meta]) => ({ url, source: meta.source }));
  state.discovery.discoveredUrls = entries.length;
  log(`Discovered ${entries.length} public URLs`);

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  try {
    await runPool(entries, 2, async (entry) => {
      await auditViewport(browser, entry.url, entry.source, 'desktop', { viewport: { width: 1440, height: 1100 } }, true, fixtures);
    });
    await runPool(entries, 3, async (entry) => {
      await auditViewport(browser, entry.url, entry.source, 'mobile', { ...devices['iPhone 13'] }, false, fixtures);
    });
  } finally {
    await browser.close();
  }

  log('Validating unique links');
  await validateUniqueLinks();
  const summary = await writeReports();
  console.log('AUDIT_SUMMARY_JSON_BEGIN');
  console.log(JSON.stringify(summary, null, 2));
  console.log('AUDIT_SUMMARY_JSON_END');
}

main().catch(async (error) => {
  console.error('FATAL_AUDIT_ERROR', error);
  state.globalErrors.push(`${error.name}: ${error.message}\n${error.stack || ''}`);
  try { await writeReports(); } catch (reportError) { console.error('REPORT_WRITE_ERROR', reportError); }
  process.exitCode = 0;
});
