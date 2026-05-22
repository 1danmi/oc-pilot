(() => {
  'use strict';

  // Guard: background.js may inject this script AND the manifest content_scripts
  // may also load it. Additionally, in dev/test mode the page's own <script src>
  // loads the same file in the page world while the extension content script runs
  // in an isolated world — window properties are world-specific and cannot block
  // cross-world double-execution. Using a data-* attribute on the root element
  // (shared DOM, visible to ALL worlds) solves both cases at once.
  if (document.documentElement.dataset.ocPilotConsoleLoaded) return;
  document.documentElement.dataset.ocPilotConsoleLoaded = '1';

  const LOG = '[oc-pilot:console]';
  // Debug logger — uses console.debug so output is hidden by default in the
  // page's DevTools (requires "Verbose" level). Keeps the user's console clean
  // while remaining accessible for extension developers.
  const _dbg = console.debug.bind(console, LOG);

  // ── Feature flags (loaded from storage, default all on) ───────────────────
  // Each flag controls an independent feature. The settings page (full tab)
  // lets the user toggle them; changes are reflected on the next navigation.
  let FEATURES = {
    ownerLink:    true,   // pod → Deployment / DC / StatefulSet button
    podTerminal:  true,   // Terminal button in pod list rows
    podLogs:      true,   // Logs button in pod list rows
    podEvents:    true,   // Events button in pod list rows
    podImageTag:  true,   // image version badge next to pod action buttons
    forceDelete:  true,   // Force Delete button on pod pages & pod list rows
    crossLinks:   true,   // Route ↔ Deployment cross-link pills
    copyLoginCmd: true,   // "Copy Login" button in the console header
    clickToCopy:  true,   // click any resource title to copy its name
    favourites:   true,   // star resources to pin them at the top of list pages
    persistSort:  true,   // remember column sort selection across navigations
  };

  // ── Telemetry helper ───────────────────────────────────────────────────────
  // Fire-and-forget bump to the background SW. Wrapped in try/catch so a
  // sleeping SW or chrome.runtime hiccup NEVER breaks a feature.
  function bumpEvent(name) {
    try { chrome.runtime.sendMessage({ type: "telemetry/bump", event: name }); } catch (_) {}
  }

  function loadFeatures(callback) {
    try {
      chrome.storage.local.get('openshiftAutoLogin', (data) => {
        const f = ((data || {}).openshiftAutoLogin || {}).features || {};
        FEATURES = {
          ownerLink:    f.ownerLink    !== false,
          podTerminal:  f.podTerminal  !== false,
          podLogs:      f.podLogs      !== false,
          podEvents:    f.podEvents    !== false,
          podImageTag:  f.podImageTag  !== false,
          forceDelete:  f.forceDelete  !== false,
          crossLinks:   f.crossLinks   !== false,
          copyLoginCmd: f.copyLoginCmd !== false,
          clickToCopy:  f.clickToCopy  !== false,
          favourites:   f.favourites   !== false,
          persistSort:  f.persistSort  !== false,
          copyLoginTimeoutSec: (typeof f.copyLoginTimeoutSec === 'number' && f.copyLoginTimeoutSec > 0)
            ? f.copyLoginTimeoutSec : 45,
        };
        if (callback) callback();
      });
    } catch (_) { if (callback) callback(); }
  }

  // Re-apply feature state when settings change (e.g. user saves in full-tab).
  // Also syncs favourites data when another tab makes changes.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.openshiftAutoLogin) {
        const nv = changes.openshiftAutoLogin.newValue || {};
        const ov = changes.openshiftAutoLogin.oldValue || {};
        const f = nv.features || {};
        FEATURES = {
          ownerLink:    f.ownerLink    !== false,
          podTerminal:  f.podTerminal  !== false,
          podLogs:      f.podLogs      !== false,
          podEvents:    f.podEvents    !== false,
          podImageTag:  f.podImageTag  !== false,
          forceDelete:  f.forceDelete  !== false,
          crossLinks:   f.crossLinks   !== false,
          copyLoginCmd: f.copyLoginCmd !== false,
          clickToCopy:  f.clickToCopy  !== false,
          favourites:   f.favourites   !== false,
          persistSort:  f.persistSort  !== false,
          copyLoginTimeoutSec: (typeof f.copyLoginTimeoutSec === 'number' && f.copyLoginTimeoutSec > 0)
            ? f.copyLoginTimeoutSec : 45,
        };
        // Skip onNavigate if only telemetry counters changed. bumpCounter writes
        // openshiftAutoLogin.telemetry.counters on every user action; reacting
        // with onNavigate() creates a clear→inject→bump→clear feedback loop that
        // makes the pod action buttons flash and prevents clicks from registering.
        const nvNoTel = { ...nv, telemetry: undefined };
        const ovNoTel = { ...ov, telemetry: undefined };
        if (JSON.stringify(nvNoTel) !== JSON.stringify(ovNoTel)) {
          // Re-run navigation handler: clears injected elements then re-injects
          // only the enabled features. Disabled features' elements are cleaned up
          // in onNavigate → clearCrossLinks / clearPodActions / id removes.
          onNavigate();
        }
      }
      if (changes.ocPilotFavourites) {
        _favs = changes.ocPilotFavourites.newValue || {};
        // Refresh the pinned section in this tab. injectPinnedSection() now
        // snapshots existing pinned rows internally so it can preserve rows
        // whose live DOM has been virtualized out — we must NOT clear here
        // first, or the snapshot would find nothing to fall back on.
        injectPinnedSection();
        // Update star icons in MAIN TABLE rows only (not the pinned section —
        // pinned rows are always amber by design; injectPinnedSection handles
        // removal when an item is un-favourited).
        document.querySelectorAll('.oc-pilot-star-wrap').forEach((wrap) => {
          if (wrap.closest('#oc-pilot-pinned-table-wrapper')) return;
          const p = wrap.dataset.starPath;
          if (!p) return;
          const pp = parseResourceDetailHref(p);
          if (!pp) return;
          const nowFav = isFavourite(pp.namespace, pp.resourceKind, pp.resourceName);
          updateStarIcon(wrap, nowFav);
        });
        // Update detail star if present.
        const detailStar = document.querySelector('.oc-pilot-detail-star');
        if (detailStar) {
          const pp = parseResourceDetailHref(location.pathname);
          if (pp) {
            const nowFav = isFavourite(pp.namespace, pp.resourceKind, pp.resourceName);
            detailStar.title = nowFav ? 'Remove from favourites' : 'Add to favourites';
            const oldSvg = detailStar.querySelector('svg');
            if (oldSvg) {
              const newSvg = buildStarSvg(nowFav);
              newSvg.setAttribute('width', '18');
              newSvg.setAttribute('height', '18');
              oldSvg.replaceWith(newSvg);
            }
          }
        }
      }
      if (changes.ocPilotClusterColours) {
        const map = (changes.ocPilotClusterColours.newValue) || {};
        _clusterColour = map[location.hostname] || null;
        applyToolbarColour();
      }
      if (changes.ocPilotSortPrefs) {
        _sortPrefs = changes.ocPilotSortPrefs.newValue || {};
      }
    });
  } catch (_) {}

  // ── Kubernetes API proxy (console backend) ────────────────────────────────

  const INTERMEDIATE_API = {
    ReplicaSet:            (ns, n) => `/api/kubernetes/apis/apps/v1/namespaces/${ns}/replicasets/${n}`,
    ReplicationController: (ns, n) => `/api/kubernetes/api/v1/namespaces/${ns}/replicationcontrollers/${n}`,
    Job:                   (ns, n) => `/api/kubernetes/apis/batch/v1/namespaces/${ns}/jobs/${n}`,
  };

  const KIND_PATH = {
    Deployment:            'deployments',
    DeploymentConfig:      'deploymentconfigs',
    StatefulSet:           'statefulsets',
    DaemonSet:             'daemonsets',
    Job:                   'jobs',
    CronJob:               'cronjobs',
    ReplicaSet:            'replicasets',
    ReplicationController: 'replicationcontrollers',
    Route:                 'routes',
  };

  // ── URL / API helpers ─────────────────────────────────────────────────────

  function parsePodUrl(pathname) {
    const m = pathname.match(/^\/k8s\/ns\/([^/]+)\/pods\/([^/?#]+)/);
    return m ? { namespace: m[1], podName: m[2] } : null;
  }

  function parseRouteUrl(pathname) {
    const m = pathname.match(/^\/k8s\/ns\/([^/]+)\/routes\/([^/?#]+)/);
    return m ? { namespace: m[1], routeName: m[2] } : null;
  }

  function parseDeploymentUrl(pathname) {
    // Matches both Deployment and DeploymentConfig detail pages.
    const m = pathname.match(/^\/k8s\/ns\/([^/]+)\/(deployments|deploymentconfigs)\/([^/?#]+)/);
    if (!m) return null;
    return {
      namespace: m[1],
      kind: m[2] === 'deploymentconfigs' ? 'DeploymentConfig' : 'Deployment',
      kindPath: m[2],
      name: m[3],
    };
  }

  async function kFetch(path) {
    const r = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${path}`);
    return r.json();
  }

  // OpenShift console's API proxy (/api/kubernetes/*) protects mutating
  // requests with CSRF middleware: the token is set as a cookie named
  // "csrf-token" on page load and must be echoed back in the X-CSRFToken
  // header. Without it, POST/PUT/DELETE return 403.
  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function kDelete(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;

    const r = await fetch(path, {
      method: 'DELETE',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        kind: 'DeleteOptions',
        apiVersion: 'v1',
        gracePeriodSeconds: opts.gracePeriodSeconds ?? 0,
        propagationPolicy: opts.propagationPolicy ?? 'Background',
      }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const data = await r.json();
        if (data.message) msg = data.message;
      } catch (_) {}
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  async function forceDeletePod(namespace, podName) {
    const ok = confirm(
      `Force delete pod "${podName}" in namespace "${namespace}"?\n\n` +
      `This skips graceful termination (gracePeriodSeconds=0) — the pod is ` +
      `removed from etcd immediately, without waiting for the kubelet to ` +
      `confirm the container was stopped.\n\n` +
      `Use this only for pods that are stuck in Terminating.`
    );
    if (!ok) return;

    _dbg(`force-deleting ${namespace}/${podName}`);
    try {
      await kDelete(
        `/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`,
        { gracePeriodSeconds: 0 }
      );
      showConsoleToast(`Force-deleted pod "${podName}"`, 'success');
      _dbg(`✓ force-deleted ${namespace}/${podName}`);

      // If we're currently ON the pod's detail page, it's about to 404.
      // Bounce to the pods list after a short delay so the toast is visible.
      const onThisPodPage = new RegExp(
        `^/k8s/ns/${namespace.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/pods/${podName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(/|$)`
      ).test(location.pathname);
      if (onThisPodPage) {
        setTimeout(() => { location.href = `/k8s/ns/${namespace}/pods`; }, 1200);
      }
    } catch (err) {
      console.error(LOG, 'force delete failed:', err);
      showConsoleToast(`Force delete failed: ${err.message}`, 'error');
    }
  }

  function showConsoleToast(text, type = 'success') {
    // Dedupe: remove any existing toast of the same type so they don't stack.
    const toastId = type === 'error' ? '__oc-pilot-err-toast__' : type === 'info' ? '__oc-pilot-info-toast__' : '__oc-pilot-ok-toast__';
    document.getElementById(toastId)?.remove();

    const host = document.createElement('div');
    host.id = toastId;
    host.setAttribute('style', [
      'all:initial',
      'position:fixed',
      // All toasts go bottom-right to stay clear of the masthead.
      // Success stacks above errors so simultaneous toasts don't overlap.
      type === 'error' ? 'bottom:18px' : 'bottom:68px',
      'right:18px',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';'));
    const shadow = host.attachShadow({ mode: 'closed' });
    const palette = type === 'error'
      ? { bg: '#7f1d1d', border: 'rgba(239,68,68,0.45)', color: '#fecaca' }
      : type === 'info'
        ? { bg: '#1e3a5f', border: 'rgba(59,130,246,0.45)', color: '#93c5fd' }
        : { bg: '#14532d', border: 'rgba(34,197,94,0.45)', color: '#86efac' };
    shadow.innerHTML = `
      <style>
        .box {
          background: ${palette.bg};
          border: 1px solid ${palette.border};
          color: ${palette.color};
          padding: 10px 12px 10px 14px;
          border-radius: 6px;
          box-shadow: 0 6px 24px rgba(0,0,0,0.35);
          font-size: 13px;
          font-weight: 500;
          max-width: 400px;
          display: flex;
          align-items: flex-start;
          gap: 10px;
          line-height: 1.4;
        }
        .msg { flex: 1; }
        .x {
          background: none;
          border: none;
          color: inherit;
          opacity: 0.55;
          cursor: pointer;
          padding: 0;
          line-height: 1;
          font-size: 15px;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .x:hover { opacity: 1; }
      </style>
      <div class="box">
        <span class="msg"></span>
        <button class="x" aria-label="Dismiss">✕</button>
      </div>
    `;
    shadow.querySelector('.msg').textContent = text;
    document.documentElement.appendChild(host);
    const timer = setTimeout(() => host.remove(), type === 'error' ? 8000 : 3500);
    shadow.querySelector('.x').addEventListener('click', () => {
      clearTimeout(timer);
      host.remove();
    });
  }

  async function resolveOwner(namespace, podName) {
    _dbg(`fetching pod ${namespace}/${podName}`);
    const pod = await kFetch(
      `/api/kubernetes/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(podName)}`
    );
    const refs = pod.metadata?.ownerReferences;
    if (!refs?.length) { _dbg('pod has no ownerReferences'); return null; }

    const { kind, name } = refs[0];
    _dbg(`direct owner: ${kind}/${name}`);

    if (!INTERMEDIATE_API[kind]) {
      // Top-level owner (StatefulSet, DaemonSet, Deployment if created directly, etc.)
      return KIND_PATH[kind] ? { kind, name, namespace } : null;
    }

    // Intermediate owner — walk one level up (RS→Deployment, RC→DC, Job→CronJob)
    try {
      const parent = await kFetch(INTERMEDIATE_API[kind](namespace, name));
      const parentRefs = parent.metadata?.ownerReferences;
      if (parentRefs?.length && KIND_PATH[parentRefs[0].kind]) {
        const top = parentRefs[0];
        _dbg(`resolved owner: ${top.kind}/${top.name}`);
        return { kind: top.kind, name: top.name, namespace };
      }
    } catch (e) {
      console.warn(LOG, `parent lookup failed (${kind}/${name}):`, e.message);
    }

    // Fall back to the intermediate itself
    return KIND_PATH[kind] ? { kind, name, namespace } : null;
  }

  // Check whether a Service selector is satisfied by a given pod-template
  // label set. Empty selector = matches nothing (k8s semantics for Services).
  function selectorMatchesLabels(selector, labels) {
    if (!selector || !Object.keys(selector).length) return false;
    for (const [k, v] of Object.entries(selector)) {
      if ((labels || {})[k] !== v) return false;
    }
    return true;
  }

  // Route → Service → Deployment/DeploymentConfig.
  // Returns { kind, name, namespace } or null.
  async function resolveRouteBackend(namespace, routeName) {
    _dbg(`fetching route ${namespace}/${routeName}`);
    const route = await kFetch(
      `/api/kubernetes/apis/route.openshift.io/v1/namespaces/${namespace}/routes/${encodeURIComponent(routeName)}`
    );
    const to = route.spec?.to;
    if (!to || to.kind !== 'Service' || !to.name) {
      _dbg('route.spec.to is not a Service; nothing to link to');
      return null;
    }

    const svc = await kFetch(
      `/api/kubernetes/api/v1/namespaces/${namespace}/services/${encodeURIComponent(to.name)}`
    ).catch((e) => { console.warn(LOG, 'service fetch failed:', e.message); return null; });
    if (!svc) return null;

    const selector = svc.spec?.selector;
    if (!selector || !Object.keys(selector).length) {
      _dbg(`service ${to.name} has no selector (headless / ExternalName); no workload link`);
      return null;
    }

    // Look at Deployments first (more common), then DCs.
    const [deps, dcs] = await Promise.all([
      kFetch(`/api/kubernetes/apis/apps/v1/namespaces/${namespace}/deployments`)
        .catch(() => ({ items: [] })),
      kFetch(`/api/kubernetes/apis/apps.openshift.io/v1/namespaces/${namespace}/deploymentconfigs`)
        .catch(() => ({ items: [] })),
    ]);

    const matchItem = (item) =>
      selectorMatchesLabels(selector, item.spec?.template?.metadata?.labels);

    const dep = (deps.items || []).find(matchItem);
    if (dep) {
      _dbg(`route → Deployment/${dep.metadata.name}`);
      return { kind: 'Deployment', name: dep.metadata.name, namespace };
    }
    const dc = (dcs.items || []).find(matchItem);
    if (dc) {
      _dbg(`route → DeploymentConfig/${dc.metadata.name}`);
      return { kind: 'DeploymentConfig', name: dc.metadata.name, namespace };
    }

    _dbg(`no Deployment/DC matches service ${to.name} selector`);
    return null;
  }

  // Deployment → Services (label-matching) → Routes (spec.to.name match).
  // Returns array of { name, host, tls, namespace } (may be empty).
  async function resolveDeploymentRoutes(namespace, kindPath, name) {
    _dbg(`fetching ${kindPath}/${name} in ${namespace}`);
    const apiGroup = kindPath === 'deploymentconfigs' ? 'apps.openshift.io/v1' : 'apps/v1';
    const dep = await kFetch(
      `/api/kubernetes/apis/${apiGroup}/namespaces/${namespace}/${kindPath}/${encodeURIComponent(name)}`
    );
    const podLabels = dep.spec?.template?.metadata?.labels || {};
    if (!Object.keys(podLabels).length) {
      _dbg('deployment has no pod-template labels; cannot map to services');
      return [];
    }

    const svcList = await kFetch(`/api/kubernetes/api/v1/namespaces/${namespace}/services`)
      .catch(() => ({ items: [] }));
    const matchingSvcNames = new Set(
      (svcList.items || [])
        .filter((s) => selectorMatchesLabels(s.spec?.selector, podLabels))
        .map((s) => s.metadata.name)
    );
    if (!matchingSvcNames.size) {
      _dbg('no services target this deployment');
      return [];
    }

    const routeList = await kFetch(
      `/api/kubernetes/apis/route.openshift.io/v1/namespaces/${namespace}/routes`
    ).catch(() => ({ items: [] }));

    const routes = (routeList.items || [])
      .filter((r) => r.spec?.to?.kind === 'Service' && matchingSvcNames.has(r.spec.to.name))
      .map((r) => ({
        name: r.metadata.name,
        host: r.spec?.host || '',
        tls: !!r.spec?.tls,
        namespace,
      }));

    _dbg(`found ${routes.length} route(s) for ${kindPath}/${name}`);
    return routes;
  }

  // ── DOM detection (multiple strategies across OCP versions) ──────────────

  function findAnchor(resourceName) {
    // Strategy 1: the specific resource-name span (stable OCP 4.x class)
    for (const sel of [
      '.co-resource-item__resource-name',
      '[data-test-id="resource-title"]',
      '[data-test="resource-title"]',
    ]) {
      const el = Array.from(document.querySelectorAll(sel))
        .find(el => el.textContent.trim() === resourceName);
      if (el) { _dbg(`anchor via "${sel}"`); return { el, mode: 'after' }; }
    }

    // Strategy 2: the co-resource-item container (wraps icon + name)
    const resourceItem = Array.from(document.querySelectorAll('.co-resource-item'))
      .find(el => el.textContent.includes(resourceName));
    if (resourceItem) {
      // Try to find a leaf text element inside it
      const leaf = Array.from(resourceItem.querySelectorAll('span, a'))
        .find(el => !el.children.length && el.textContent.trim() === resourceName);
      if (leaf) { _dbg('anchor via .co-resource-item > leaf'); return { el: leaf, mode: 'after' }; }
      _dbg('anchor via .co-resource-item');
      return { el: resourceItem, mode: 'after' };
    }

    // Strategy 3: any h1 that contains the resource name
    const h1 = Array.from(document.querySelectorAll('h1'))
      .find(el => (el.textContent || '').includes(resourceName));
    if (h1) {
      // Prefer a leaf child that is exactly the resource name
      const leaf = Array.from(h1.querySelectorAll('span, a'))
        .find(el => !el.children.length && el.textContent.trim() === resourceName);
      if (leaf) { _dbg('anchor via h1 > leaf span'); return { el: leaf, mode: 'after' }; }
      _dbg('anchor via h1 (append)');
      return { el: h1, mode: 'append' };
    }

    // Strategy 4: any element whose trimmed text is exactly the resource name
    // (last resort — scan visible headings)
    for (const tag of ['h2', 'h3', '[class*="heading"]', '[class*="title"]']) {
      const el = Array.from(document.querySelectorAll(tag))
        .find(el => el.textContent.trim() === resourceName);
      if (el) { _dbg(`anchor via "${tag}"`); return { el, mode: 'after' }; }
    }

    return null;
  }

  // ── Button creation ───────────────────────────────────────────────────────

  function buildButton(owner) {
    const href = `/k8s/ns/${owner.namespace}/${KIND_PATH[owner.kind]}/${owner.name}`;
    const btn = document.createElement('a');
    btn.id = 'oc-pilot-owner-btn';
    btn.href = href;
    btn.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'margin-left:12px',
      'padding:3px 10px 3px 8px',
      'font-size:11.5px',
      'font-weight:600',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'background:#0f1117',
      'color:#e5e7eb',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:5px',
      'cursor:pointer',
      'vertical-align:middle',
      'text-decoration:none',
      'letter-spacing:0.02em',
      'white-space:nowrap',
      'line-height:1.5',
      'transition:background 0.15s,border-color 0.15s',
    ].join(';'));
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      </svg>
      <span>${escHtml(owner.kind)}: ${escHtml(owner.name)}</span>
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = '#1e2130'; btn.style.borderColor = 'rgba(255,255,255,0.30)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0f1117'; btn.style.borderColor = 'rgba(255,255,255,0.18)'; });
    btn.addEventListener('click', () => { bumpEvent('click.ownerLink'); });
    return btn;
  }

  // Red destructive "Force Delete" pill. Used on the pod detail page (standalone)
  // and on each pods-list row (alongside the Terminal/Logs/Events quick-jumps).
  // `size` controls padding + font size so the same builder works for both:
  //   - 'lg' matches the owner button (header area, pod detail page)
  //   - 'sm' matches the mini row actions (pods list)
  function buildForceDeleteButton(namespace, podName, size = 'lg') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oc-pilot-force-delete-btn';
    btn.title = `Force delete pod "${podName}" (skips graceful termination)`;
    const large = size === 'lg';
    btn.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      large ? 'margin-left:8px' : 'margin-left:0',
      large ? 'padding:3px 10px 3px 8px' : 'padding:1px 7px',
      large ? 'font-size:11.5px' : 'font-size:10.5px',
      'font-weight:600',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      // Subtle so the button doesn't scream at you — but clearly red so it's
      // obvious it's destructive.
      'background:#2a0f12',
      'color:#fecaca',
      'border:1px solid rgba(239,68,68,0.45)',
      large ? 'border-radius:5px' : 'border-radius:3px',
      'cursor:pointer',
      'vertical-align:middle',
      'letter-spacing:0.02em',
      'white-space:nowrap',
      'line-height:1.5',
      'transition:background 0.15s,border-color 0.15s,color 0.15s',
    ].join(';'));
    const iconSize = large ? 11 : 10;
    btn.innerHTML = `
      <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
      <span>Force Delete</span>
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#7f1d1d';
      btn.style.borderColor = 'rgba(239,68,68,0.8)';
      btn.style.color = '#ffffff';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#2a0f12';
      btn.style.borderColor = 'rgba(239,68,68,0.45)';
      btn.style.color = '#fecaca';
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bumpEvent('click.forceDelete');
      forceDeletePod(namespace, podName);
    });
    return btn;
  }

  // ── Injection logic ───────────────────────────────────────────────────────

  let lastPodKey = '';
  let inFlight = false;
  let pollTimer = null;

  async function tryInject() {
    if (!FEATURES.ownerLink) return;
    const parsed = parsePodUrl(location.pathname);
    if (!parsed) return;

    const { namespace, podName } = parsed;
    const key = `${namespace}/${podName}`;
    if (lastPodKey === key || inFlight) return;

    const anchor = findAnchor(podName);
    if (!anchor) return; // not rendered yet — observer/poll will retry

    lastPodKey = key;
    inFlight = true;
    stopPoll(); // anchor found, polling no longer needed

    // ── Skeleton shimmer keyframes (injected once) ────────────────────────────
    if (!document.getElementById('oc-pilot-styles')) {
      const s = document.createElement('style');
      s.id = 'oc-pilot-styles';
      s.textContent = [
        '@keyframes oc-skeleton{',
        '0%{background-position:200% 0}',
        '100%{background-position:-200% 0}',
        '}',
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    // ── Skeleton placeholder — same dimensions as the real owner button ───────
    // Width ~130px matches a typical "Deployment: name" label so there's no
    // layout shift when the real button swaps in.
    let loadingEl = document.createElement('span');
    loadingEl.id = 'oc-pilot-loading';
    loadingEl.setAttribute('style', [
      'display:inline-block',
      'width:130px',
      'height:22px',
      'margin-left:12px',
      'vertical-align:middle',
      'border-radius:5px',
      'background:linear-gradient(90deg,rgba(255,255,255,0.05) 25%,rgba(255,255,255,0.11) 50%,rgba(255,255,255,0.05) 75%)',
      'background-size:200% 100%',
      'animation:oc-skeleton 1.4s ease-in-out infinite',
    ].join(';'));
    if (anchor.mode === 'after') anchor.el.insertAdjacentElement('afterend', loadingEl);
    else anchor.el.appendChild(loadingEl);

    try {
      const owner = await resolveOwner(namespace, podName);
      loadingEl.remove();
      if (!owner) { _dbg('no linkable owner found'); return; }
      if (document.getElementById('oc-pilot-owner-btn')) return; // already there
      const btn = buildButton(owner);
      if (anchor.mode === 'after') anchor.el.insertAdjacentElement('afterend', btn);
      else anchor.el.appendChild(btn);
      _dbg(`✓ injected button → ${owner.kind}/${owner.name}`);
    } catch (err) {
      loadingEl.remove();
      console.warn(LOG, 'owner lookup failed:', err.message);
      lastPodKey = ''; // allow retry
    } finally {
      inFlight = false;
    }
  }

  function startPoll() {
    stopPoll();
    let ticks = 0;
    pollTimer = setInterval(() => {
      if (++ticks > 30) { stopPoll(); console.warn(LOG, 'gave up polling for anchor'); return; }
      tryInject();
    }, 500);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Force Delete button on the pod detail page — independent of owner lookup
  // (a bare pod with no ownerReferences still needs this button).
  let lastForceKey = '';
  let forcePollTimer = null;

  function tryInjectForceDelete() {
    if (!FEATURES.forceDelete) return;
    const parsed = parsePodUrl(location.pathname);
    if (!parsed) return;

    const { namespace, podName } = parsed;
    const key = `${namespace}/${podName}`;
    if (lastForceKey === key && document.getElementById('oc-pilot-force-delete-btn')) return;

    const anchor = findAnchor(podName);
    if (!anchor) return;

    // Already injected for this pod? Nothing to do.
    if (document.getElementById('oc-pilot-force-delete-btn')) {
      lastForceKey = key;
      return;
    }

    const btn = buildForceDeleteButton(namespace, podName, 'lg');
    btn.id = 'oc-pilot-force-delete-btn';

    // Prefer placing AFTER the owner button if it's already there, so the
    // header reads:  <pod-name>  [Deployment: foo]  [Force Delete]
    const ownerBtn = document.getElementById('oc-pilot-owner-btn');
    if (ownerBtn) {
      ownerBtn.insertAdjacentElement('afterend', btn);
    } else if (anchor.mode === 'after') {
      anchor.el.insertAdjacentElement('afterend', btn);
    } else {
      anchor.el.appendChild(btn);
    }

    lastForceKey = key;
    stopForcePoll();
    _dbg(`✓ injected force-delete button for ${namespace}/${podName}`);
  }

  function startForcePoll() {
    stopForcePoll();
    let ticks = 0;
    forcePollTimer = setInterval(() => {
      if (++ticks > 30) { stopForcePoll(); return; }
      tryInjectForceDelete();
    }, 500);
  }
  function stopForcePoll() {
    if (forcePollTimer) { clearInterval(forcePollTimer); forcePollTimer = null; }
  }

  // ── Route ↔ Deployment cross-links ────────────────────────────────────────
  //
  //  • On a Route page, inject a single "Deployment: <name>" button (or
  //    "DeploymentConfig: <name>") that navigates to the workload behind it.
  //  • On a Deployment / DeploymentConfig page, inject one "Route: <name>"
  //    button per Route that ultimately targets this workload.

  // Shared cube/compass/globe pill style. `icon` is raw SVG inner markup.
  function buildLinkButton({ id, href, kind, name, tooltip, icon }) {
    const btn = document.createElement('a');
    if (id) btn.id = id;
    btn.className = 'oc-pilot-link-btn';
    btn.href = href;
    if (tooltip) btn.title = tooltip;
    btn.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'margin-left:8px',
      'padding:3px 10px 3px 8px',
      'font-size:11.5px',
      'font-weight:600',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'background:#0f1117',
      'color:#e5e7eb',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:5px',
      'cursor:pointer',
      'vertical-align:middle',
      'text-decoration:none',
      'letter-spacing:0.02em',
      'white-space:nowrap',
      'line-height:1.5',
      'transition:background 0.15s,border-color 0.15s',
    ].join(';'));
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        ${icon}
      </svg>
      <span>${kind ? escHtml(kind) + ': ' + escHtml(name) : escHtml(name)}</span>
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#1e2130';
      btn.style.borderColor = 'rgba(255,255,255,0.30)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#0f1117';
      btn.style.borderColor = 'rgba(255,255,255,0.18)';
    });
    return btn;
  }

  const ICON_DEPLOYMENT =
    `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>`;
  const ICON_ROUTE =
    `<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`;
  // Route page → Deployment/DC button
  let lastRouteKey = '';
  let routeInFlight = false;
  let routePollTimer = null;

  async function tryInjectRouteBackend() {
    if (!FEATURES.crossLinks) return;
    const parsed = parseRouteUrl(location.pathname);
    if (!parsed) return;

    const { namespace, routeName } = parsed;
    const key = `${namespace}/${routeName}`;
    if (lastRouteKey === key || routeInFlight) return;

    const anchor = findAnchor(routeName);
    if (!anchor) return; // observer/poll will retry

    lastRouteKey = key;
    routeInFlight = true;
    stopRoutePoll();

    try {
      const backend = await resolveRouteBackend(namespace, routeName);
      if (!backend) { _dbg('no backend workload for route'); return; }
      if (document.getElementById('oc-pilot-route-backend-btn')) return;
      const btn = buildLinkButton({
        id: 'oc-pilot-route-backend-btn',
        href: `/k8s/ns/${backend.namespace}/${KIND_PATH[backend.kind]}/${backend.name}`,
        kind: backend.kind,
        name: backend.name,
        tooltip: `Go to ${backend.kind} backing this route`,
        icon: ICON_DEPLOYMENT,
      });
      btn.addEventListener('click', () => bumpEvent('click.crossLinks.routeToBackend'));
      if (anchor.mode === 'after') anchor.el.insertAdjacentElement('afterend', btn);
      else anchor.el.appendChild(btn);
      _dbg(`✓ injected route-backend button → ${backend.kind}/${backend.name}`);
    } catch (err) {
      console.warn(LOG, 'route backend lookup failed:', err.message);
      lastRouteKey = ''; // allow retry
    } finally {
      routeInFlight = false;
    }
  }

  function startRoutePoll() {
    stopRoutePoll();
    let ticks = 0;
    routePollTimer = setInterval(() => {
      if (++ticks > 30) { stopRoutePoll(); return; }
      tryInjectRouteBackend();
    }, 500);
  }
  function stopRoutePoll() {
    if (routePollTimer) { clearInterval(routePollTimer); routePollTimer = null; }
  }

  // Deployment/DC page → Route button(s)
  let lastDepKey = '';
  let depInFlight = false;
  let depPollTimer = null;

  async function tryInjectDeploymentRoutes() {
    if (!FEATURES.crossLinks) return;
    const parsed = parseDeploymentUrl(location.pathname);
    if (!parsed) return;

    const { namespace, kind, kindPath, name } = parsed;
    const key = `${namespace}/${kindPath}/${name}`;
    if (lastDepKey === key || depInFlight) return;

    const anchor = findAnchor(name);
    if (!anchor) return;

    lastDepKey = key;
    depInFlight = true;
    stopDepPoll();

    try {
      const routes = await resolveDeploymentRoutes(namespace, kindPath, name);
      if (!routes.length) { _dbg('no routes found'); return; }
      // Dedupe: if some of these routes are already injected, skip them.
      const existing = new Set(
        Array.from(document.querySelectorAll('[data-oc-pilot-route]'))
          .map((el) => el.getAttribute('data-oc-pilot-route'))
      );

      // Build a wrapper so all route buttons flow together after the name
      // anchor. Reusing a single wrapper simplifies cleanup on navigation.
      let wrap = document.getElementById('oc-pilot-dep-routes');
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.id = 'oc-pilot-dep-routes';
        wrap.setAttribute('style', 'display:inline-flex;align-items:center;gap:4px;vertical-align:middle;');
        if (anchor.mode === 'after') anchor.el.insertAdjacentElement('afterend', wrap);
        else anchor.el.appendChild(wrap);
      }

      let addedCount = 0;
      routes.forEach((r) => {
        if (existing.has(r.name)) return;

        // Pill 1 — links to the route's page inside the OpenShift console.
        const btn = buildLinkButton({
          href: `/k8s/ns/${r.namespace}/routes/${r.name}`,
          kind: 'Route',
          name: r.name,
          tooltip: r.host
            ? `${r.tls ? 'https' : 'http'}://${r.host} — click to open route page`
            : 'Route details',
          icon: ICON_ROUTE,
        });
        btn.setAttribute('data-oc-pilot-route', r.name);
        btn.addEventListener('click', () => bumpEvent('click.crossLinks.deploymentToRoute'));
        wrap.appendChild(btn);

        addedCount++;
      });
      _dbg(`✓ injected ${addedCount} route link(s) on ${kind} page`);

      // Cache routes so the details-panel injector can use the same data
      // without a second API call (it runs separately once the details DOM renders).
      cachedDepRoutes = { key, routes };
      tryInjectRouteDetails();
    } catch (err) {
      console.warn(LOG, 'deployment-routes lookup failed:', err.message);
      lastDepKey = ''; // allow retry
    } finally {
      depInFlight = false;
    }
  }

  function startDepPoll() {
    stopDepPoll();
    let ticks = 0;
    depPollTimer = setInterval(() => {
      if (++ticks > 30) { stopDepPoll(); return; }
      tryInjectDeploymentRoutes();
    }, 500);
  }
  function stopDepPoll() {
    if (depPollTimer) { clearInterval(depPollTimer); depPollTimer = null; }
  }

  // ── Route URLs in the deployment details panel ────────────────────────────
  // After the route API calls complete, we cache the result here so the
  // details-panel injector can use the data without a second request.
  let cachedDepRoutes = null; // { key: string, routes: Array }

  // Locate the "Labels" row in the details definition-list.
  // Returns { type:'group'|'flat', afterEl } or null if not rendered yet.
  // Handles both:
  //   PF4 flat   — <dl><dt>Labels</dt><dd>…</dd>…</dl>
  //   PF5 grouped — <dl><div class="*description-list__group"><dt><span>Labels</span></dt><dd>…</dd></div>…</dl>
  function findLabelsAnchor() {
    // ── Helper: primary label text of a <dt>, ignoring edit buttons/icons ──────
    // PF5 wraps the label in the first <span> child.
    // PF4 leaves it as a direct text node; the edit button is a sibling element.
    function termText(el) {
      // PF5: first direct child is a <span> — its text IS the label
      const fc = el.firstElementChild;
      if (fc && fc.tagName === 'SPAN') {
        const t = fc.textContent.trim();
        if (t) return t;
      }
      // PF4: collect only direct text nodes (buttons/links/icons are element children)
      const directTxt = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ');
      if (directTxt) return directTxt;
      // No element children — use full text
      if (!fc) return el.textContent.trim();
      // Last resort: first line only (before any button/icon text on separate lines)
      return el.textContent.trim().split('\n')[0].trim();
    }

    // ── Strategy A: locate the "Labels" <dt> directly ─────────────────────────
    const dts = Array.from(document.querySelectorAll('dt'));
    const labelsDt = dts.find((el) => termText(el) === 'Labels');

    if (labelsDt) {
      // PF5: dt is nested inside a description-list__group wrapper
      const group = labelsDt.closest('[class*="description-list__group"]');
      if (group) return { type: 'group', afterEl: group };

      // PF4 flat dl: walk forward to the sibling <dd>
      let sib = labelsDt.nextElementSibling;
      while (sib && sib.tagName !== 'DD') sib = sib.nextElementSibling;
      if (sib) return { type: 'flat', dtEl: labelsDt, afterEl: sib };
      return { type: 'flat', dtEl: labelsDt, afterEl: labelsDt };
    }

    // ── Strategy A2: find "Pod selector" and insert just before it ────────────
    // Used when the Labels dt isn't directly found but "Pod selector" is.
    // Inserting before Pod selector puts Routes in the same position as
    // inserting after Labels (they are always adjacent in the OCP details panel).
    const podSelectorDt = dts.find((el) => termText(el) === 'Pod selector');
    if (podSelectorDt) {
      // PF5 grouped: each label is its own description-list__group div
      const psGroup = podSelectorDt.closest('[class*="description-list__group"]');
      if (psGroup) {
        const prevGroup = psGroup.previousElementSibling;
        if (prevGroup) {
          _dbg('route-details: anchoring before Pod selector (Strategy A2)');
          return { type: 'group', afterEl: prevGroup };
        }
      }
      // PF4 flat: find the <dd> immediately before the Pod selector <dt>
      const prevDd = (podSelectorDt.previousElementSibling?.tagName === 'DD')
        ? podSelectorDt.previousElementSibling : null;
      const prevDt = (prevDd?.previousElementSibling?.tagName === 'DT')
        ? prevDd.previousElementSibling : null;
      if (prevDd) {
        _dbg('route-details: anchoring before Pod selector (Strategy A2 flat)');
        return { type: 'flat', dtEl: prevDt, afterEl: prevDd };
      }
    }

    // ── Strategy B: find the details <dl> and append after the last entry ──────
    // Used when the Labels dt can't be matched by text (different locale, DOM
    // structure variation, etc.) but the details panel IS rendered.
    // We identify the right <dl> by scanning for other known detail labels.
    const knownLabels = new Set([
      'Name', 'Namespace', 'Created At', 'Created', 'Owner', 'Annotations',
      'Status', 'Replicas', 'Strategy', 'Selector', 'Update strategy',
    ]);
    for (const dl of document.querySelectorAll('dl')) {
      const dlDts = Array.from(dl.querySelectorAll('dt'));
      const matches = dlDts.filter((dt) => knownLabels.has(termText(dt))).length;
      if (matches < 2) continue; // not the details panel

      // PF5: top-level children are description-list__group divs
      const topGroups = Array.from(dl.children).filter(
        (el) => el.className && el.className.includes('description-list__group')
      );
      if (topGroups.length) {
        _dbg('route-details: Labels dt not found, appending after last group (Strategy B)');
        return { type: 'group', afterEl: topGroups[topGroups.length - 1] };
      }

      // PF4 flat: append after the last <dd>
      const topDds   = Array.from(dl.children).filter((el) => el.tagName === 'DD');
      const topDtEls = Array.from(dl.children).filter((el) => el.tagName === 'DT');
      const lastDd   = topDds[topDds.length - 1];
      const lastDt   = topDtEls[topDtEls.length - 1] || null;
      if (lastDd) {
        _dbg('route-details: Labels dt not found, appending after last dd (Strategy B)');
        return { type: 'flat', dtEl: lastDt, afterEl: lastDd };
      }
    }

    // Diagnostic: nothing found — log what dt texts ARE on the page so the user
    // can share them to help us refine the selector.
    _dbg(
      'route-details: Labels anchor not found. dt primary texts on page:',
      dts.map(termText).filter(Boolean).slice(0, 20)
    );
    return null;
  }

  function buildDetailsCopyButton(url) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `Copy ${url}`;
    btn.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'padding:2px 8px 2px 6px',
      'font-size:11.5px',
      'font-weight:500',
      'font-family:inherit',
      'background:transparent',
      'color:inherit',
      'opacity:0.55',
      'border:1px solid currentColor',
      'border-radius:4px',
      'cursor:pointer',
      'flex-shrink:0',
      'transition:opacity 0.15s,background 0.15s',
      'vertical-align:middle',
    ].join(';'));
    btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      <span>Copy</span>
    `;
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { if (!btn.dataset.copied) btn.style.opacity = '0.55'; });
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      btn.dataset.copied = '1';
      btn.style.opacity = '1';
      btn.style.color = '#16a34a';
      btn.querySelector('span').textContent = 'Copied!';
      setTimeout(() => {
        delete btn.dataset.copied;
        btn.style.opacity = '0.55';
        btn.style.color = '';
        btn.querySelector('span').textContent = 'Copy';
      }, 2000);
    });
    return btn;
  }

  function tryInjectRouteDetails() {
    if (!FEATURES.crossLinks) return;
    if (!cachedDepRoutes) return;
    if (document.getElementById('oc-pilot-route-details')) return;

    const depParsed = parseDeploymentUrl(location.pathname);
    if (!depParsed) return;
    const currentKey = `${depParsed.namespace}/${depParsed.kindPath}/${depParsed.name}`;
    if (cachedDepRoutes.key !== currentKey) return;

    const routes = cachedDepRoutes.routes.filter((r) => r.host);
    if (!routes.length) return;

    const anchor = findLabelsAnchor();
    if (!anchor) return; // details panel not rendered yet — observer will retry

    // Build the URL list content
    const urlList = document.createElement('div');
    urlList.setAttribute('style', 'display:flex;flex-direction:column;gap:7px;');
    routes.forEach((r) => {
      const scheme = r.tls ? 'https' : 'http';
      const url = `${scheme}://${r.host}`;
      const row = document.createElement('div');
      row.setAttribute('style', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      link.setAttribute('style', 'font-size:13px;text-decoration:none;color:#1fa7f8;word-break:break-all;');
      link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
      link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
      // Don't preventDefault — opening the external URL in a new tab is the
      // intended action; we just want to count the engagement.
      link.addEventListener('click', () => bumpEvent('click.crossLinks.deploymentToRouteUrl'));
      row.appendChild(link);
      row.appendChild(buildDetailsCopyButton(url));
      urlList.appendChild(row);
    });

    // Suppress PatternFly's row-separator border (the thin line that PF draws
    // between description-list items via border-top on groups/dts).
    const NO_BORDER = 'border:none!important;border-top:none!important;border-bottom:none!important;';

    if (anchor.type === 'group') {
      // PF5: clone the group wrapper and its dt/dd structure, swap in our content.
      const srcGroup = anchor.afterEl;
      const newGroup = document.createElement('div');
      newGroup.id = 'oc-pilot-route-details';
      newGroup.className = srcGroup.className;
      newGroup.style.cssText = NO_BORDER;

      const srcDt = srcGroup.querySelector('dt');
      const srcDd = srcGroup.querySelector('dd');

      const newDt = document.createElement('dt');
      if (srcDt) newDt.className = srcDt.className;
      newDt.style.cssText = NO_BORDER;
      // PF5 wraps the label text in a <span>; mirror that if present.
      const srcSpan = srcDt && srcDt.querySelector('span');
      if (srcSpan) {
        const span = document.createElement('span');
        span.className = srcSpan.className;
        span.textContent = 'Routes';
        newDt.appendChild(span);
      } else {
        newDt.textContent = 'Routes';
      }

      const newDd = document.createElement('dd');
      if (srcDd) newDd.className = srcDd.className;
      newDd.style.cssText = NO_BORDER;
      // PF5 wraps the value in a <div>; mirror that if present.
      const srcDdDiv = srcDd && srcDd.querySelector('div');
      if (srcDdDiv) {
        const wrap = document.createElement('div');
        wrap.className = srcDdDiv.className;
        wrap.appendChild(urlList);
        newDd.appendChild(wrap);
      } else {
        newDd.appendChild(urlList);
      }

      newGroup.appendChild(newDt);
      newGroup.appendChild(newDd);
      anchor.afterEl.insertAdjacentElement('afterend', newGroup);

    } else {
      // PF4 flat dl: insert a bare <dt>/<dd> pair after the Labels dd.
      const newDd = document.createElement('dd');
      newDd.id = 'oc-pilot-route-details';
      if (anchor.afterEl.className) newDd.className = anchor.afterEl.className;
      newDd.style.cssText = NO_BORDER;
      newDd.appendChild(urlList);

      const newDt = document.createElement('dt');
      newDt.id = 'oc-pilot-route-details-dt';
      if (anchor.dtEl && anchor.dtEl.className) newDt.className = anchor.dtEl.className;
      newDt.style.cssText = NO_BORDER;
      newDt.textContent = 'Routes';

      // Flat dl: insert dt first, then dd (afterend reverses order)
      anchor.afterEl.insertAdjacentElement('afterend', newDd);
      anchor.afterEl.insertAdjacentElement('afterend', newDt);
    }

    _dbg(`✓ injected route details for ${routes.length} route(s) in details panel`);
  }

  function clearCrossLinks() {
    document.getElementById('oc-pilot-route-backend-btn')?.remove();
    document.getElementById('oc-pilot-dep-routes')?.remove();
    document.getElementById('oc-pilot-route-details')?.remove();
    document.getElementById('oc-pilot-route-details-dt')?.remove();
    cachedDepRoutes = null;
  }

  // ── Click-to-copy resource name ──────────────────────────────────────────
  //
  // On any resource detail page (/k8s/(ns|cluster)/<kind>/<name>…), the
  // resource name shown in the page heading becomes a click target that copies
  // the name to the clipboard.  Feedback: brief opacity "press" animation, a
  // 2-second green flash on the element, an inline "✓ Copied" badge, and a
  // toast notification.  The cursor changes to pointer and a tooltip hints at
  // the feature.  List pages are unaffected — the click only applies to the
  // title element on the resource detail view, which is never a navigable link.

  let _copyNamePollTimer = null;

  function parseCurrentResourceName(pathname) {
    // Matches /k8s/(ns/<ns>|all-namespaces|cluster)/<kind>/<name>[/<subpage>]
    // Captures the resource-name segment regardless of trailing sub-pages.
    const m = pathname.match(
      /^\/k8s\/(?:ns\/[^/]+|all-namespaces|cluster)\/[^/]+\/([^/?#]+)/
    );
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  }

  function tryInjectClickToCopy() {
    if (!FEATURES.clickToCopy) return;
    const name = parseCurrentResourceName(location.pathname);
    if (!name) return;

    const anchor = findAnchor(name);
    if (!anchor) return; // not rendered yet — observer/poll will retry

    const el = anchor.el;

    // Never attach to a navigable link or breadcrumb — we'd block navigation.
    if (el.tagName === 'A' || el.closest('a') || el.closest('nav, [aria-label="Breadcrumb"]')) return;

    // Idempotent: skip if already wired up for this element instance.
    if (el.dataset.ocPilotCopy) return;
    el.dataset.ocPilotCopy = '1';
    stopCopyNamePoll(); // found — stop polling

    el.style.cursor = 'pointer';
    el.title = 'Click to copy name';

    el.addEventListener('mouseenter', () => {
      if (!el.dataset.copyFlash) {
        el.style.textDecoration = 'underline';
        el.style.textDecorationStyle = 'dotted';
        el.style.textUnderlineOffset = '3px';
      }
    });
    el.addEventListener('mouseleave', () => {
      if (!el.dataset.copyFlash) el.style.textDecoration = '';
    });

    el.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      bumpEvent('click.clickToCopy');

      // "Pressed" animation: quick opacity dip mimicking a button click.
      el.style.transition = 'opacity 0.08s';
      el.style.opacity = '0.4';
      el.style.textDecoration = '';
      setTimeout(() => {
        el.style.opacity = '';
        setTimeout(() => { el.style.transition = ''; }, 100);
      }, 130);

      // Copy the name — try navigator.clipboard first, fall back to background.
      let copied = false;
      try {
        await navigator.clipboard.writeText(name);
        copied = true;
      } catch (_) {
        copied = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'copyToClipboard', text: name }, (resp) => {
              if (chrome.runtime.lastError) { resolve(false); return; }
              resolve(!!(resp && resp.ok));
            });
          } catch { resolve(false); }
        });
      }

      if (copied) {
        // Green flash on the title element for 2 s.
        el.dataset.copyFlash = '1';
        el.style.color = '#22c55e';
        el.style.transition = 'color 0.25s';
        el.style.textDecoration = '';

        // Inline "✓ Copied" badge that fades in then fades out.
        const badge = document.createElement('span');
        badge.setAttribute('style', [
          'display:inline-flex', 'align-items:center',
          'margin-left:9px', 'padding:2px 8px',
          'font-size:10.5px', 'font-weight:600',
          'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'background:#14532d', 'color:#86efac',
          'border:1px solid rgba(34,197,94,0.4)',
          'border-radius:4px', 'vertical-align:middle',
          'letter-spacing:0.02em',
          'opacity:0', 'transition:opacity 0.18s',
          'pointer-events:none',
        ].join(';'));
        badge.textContent = '✓ Copied';
        el.insertAdjacentElement('afterend', badge);
        requestAnimationFrame(() => { badge.style.opacity = '1'; });

        setTimeout(() => {
          delete el.dataset.copyFlash;
          el.style.color = '';
          el.style.transition = '';
          badge.style.opacity = '0';
          setTimeout(() => badge.remove(), 200);
        }, 2000);

        showConsoleToast(`"${name}" copied to clipboard`, 'success');
      } else {
        showConsoleToast('Could not copy to clipboard', 'error');
      }
    });

    _dbg(`✓ click-to-copy attached to "${name}"`);
  }

  function startCopyNamePoll() {
    stopCopyNamePoll();
    // Only poll when the feature is on and we're on a resource detail page.
    if (!FEATURES.clickToCopy) return;
    if (!parseCurrentResourceName(location.pathname)) return;
    let ticks = 0;
    _copyNamePollTimer = setInterval(() => {
      if (++ticks > 30) { stopCopyNamePoll(); return; }
      tryInjectClickToCopy();
    }, 500);
  }

  function stopCopyNamePoll() {
    if (_copyNamePollTimer) { clearInterval(_copyNamePollTimer); _copyNamePollTimer = null; }
  }

  // ── Copy Login Command header button ─────────────────────────────────────
  //
  // Injects a small "Copy Login" pill into the OCP console's top-right header
  // area. When clicked it sends the OAuth token-request URL to the background
  // service worker, which fetches the token pages directly (using the browser's
  // live session cookies via credentials:'include') without opening any tab,
  // extracts the oc login command, copies it to the clipboard, and sends a
  // toast back to this tab confirming success or failure.

  function getTokenRequestUrl() {
    // Console hostname:  console-openshift-console.apps.<domain>
    // OAuth hostname:    oauth-openshift.apps.<domain>
    const h = location.hostname.replace(/^console-openshift-console\./, 'oauth-openshift.');
    return `https://${h}/oauth/token/request`;
  }

  function injectCopyLoginButton() {
    if (!FEATURES.copyLoginCmd) return;
    if (document.getElementById('oc-pilot-copy-login-btn')) return;

    // OCP header toolbar — try PF5 masthead first, then PF4, then generic fallbacks.
    const container =
      document.querySelector('.pf-v5-c-masthead__content') ||
      document.querySelector('.pf-c-page__header-tools') ||
      document.querySelector('[class*="masthead__content"]') ||
      document.querySelector('[class*="header-tools"]');

    if (!container) return; // header not rendered yet — observer will retry

    const btn = document.createElement('button');
    btn.id   = 'oc-pilot-copy-login-btn';
    btn.type = 'button';
    btn.title = 'Copy oc login command to clipboard (OC Pilot)';
    btn.setAttribute('style', [
      'display:inline-flex', 'align-items:center', 'gap:5px',
      'margin:0 6px', 'padding:4px 11px 4px 9px',
      'font-size:11.5px', 'font-weight:600',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'background:#0f1117', 'color:#e5e7eb',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:5px', 'cursor:pointer',
      'white-space:nowrap', 'letter-spacing:0.02em',
      'transition:background 0.15s,border-color 0.15s',
      'vertical-align:middle',
      'flex-shrink:0',
    ].join(';'));

    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <rect x="9" y="9" width="13" height="13" rx="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      <span>Copy Login</span>
    `;

    btn.addEventListener('mouseenter', () => {
      if (!btn.dataset.loading) {
        btn.style.background = '#1e2130';
        btn.style.borderColor = 'rgba(255,255,255,0.30)';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.loading) {
        btn.style.background = '#0f1117';
        btn.style.borderColor = 'rgba(255,255,255,0.18)';
      }
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.loading) return;
      bumpEvent('click.copyLoginCmd');

      btn.dataset.loading = '1';
      btn.querySelector('span').textContent = 'Fetching…';
      btn.style.opacity = '0.7';
      btn.style.cursor  = 'default';

      const tokenRequestUrl = getTokenRequestUrl();
      _dbg('[CopyLogin] click — tokenRequestUrl:', tokenRequestUrl);
      try {
        chrome.runtime.sendMessage({ type: 'copyLoginCommand', tokenRequestUrl, consoleHostname: location.hostname }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn(LOG, '[CopyLogin] sendMessage error:', chrome.runtime.lastError.message);
            resetCopyLoginButton();
            showConsoleToast('Failed to start token fetch', 'error');
            return;
          }
          _dbg('[CopyLogin] background ack:', resp);
        });
      } catch (err) {
        console.warn(LOG, '[CopyLogin] sendMessage exception:', err);
        resetCopyLoginButton();
        const isStale = /context invalidated/i.test((err && err.message) || '');
        showConsoleToast(
          isStale ? 'Extension updated — please refresh the page' : 'Failed to start token fetch',
          'error'
        );
      }

      // Safety-net reset if the background never responds (e.g. cluster throttling).
      // Default 45 s; configurable via OC Pilot settings → Copy Login timeout.
      const _clTimeout = (FEATURES.copyLoginTimeoutSec || 45) * 1000;
      setTimeout(() => {
        resetCopyLoginButton();
        showConsoleToast('Timeout — wait a moment and try again', 'error');
      }, _clTimeout);
    });

    // Place the button immediately to the LEFT of the user dropdown so it sits
    // next to the username, not pushed all the way into the corner.
    // OCP uses several different class/data-test conventions across versions.
    const userMenu =
      container.querySelector('[data-test="user-dropdown"]')      ||
      container.querySelector('[data-testid="user-dropdown"]')    ||
      container.querySelector('[data-test*="user"]')              ||
      container.querySelector('[class*="user-toggle"]')           ||
      container.querySelector('[class*="username"]');

    // Walk up to the closest toolbar-item wrapper if found, so we insert at
    // the right level of the DOM hierarchy.
    const anchor = userMenu
      ? (userMenu.closest('li, [class*="toolbar__item"], [class*="header-tools__item"]') || userMenu)
      : null;

    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(btn, anchor);
    } else {
      // Fallback: insert before the last child of the container
      // (which is almost always the user menu in every OCP version).
      const last = container.lastElementChild;
      last ? container.insertBefore(btn, last) : container.appendChild(btn);
    }

    _dbg('✓ injected Copy Login button');
  }

  function resetCopyLoginButton() {
    const btn = document.getElementById('oc-pilot-copy-login-btn');
    if (!btn) return;
    delete btn.dataset.loading;
    btn.querySelector('span').textContent = 'Copy Login';
    btn.style.opacity = '';
    btn.style.cursor  = 'pointer';
    btn.style.background   = '#0f1117';
    btn.style.borderColor  = 'rgba(255,255,255,0.18)';
  }

  // Listen for toast / button-reset messages sent by the background service
  // worker after the silent tab completes (or fails) the token-fetch flow.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'ocPilotToast') {
        showConsoleToast(msg.text || '', msg.style || 'success');
        // resetButton: false is sent for interim retry notifications so the
        // button stays in "Fetching…" while the background retries.
        if (msg.resetButton !== false) resetCopyLoginButton();
      }
    });
  } catch (_) {}

  // ── Pod action buttons (Terminal / Logs / Events) ─────────────────────────
  //
  // On any pods-list page (Deployment/DC/STS/DS/RS/Job → Pods tab, or the
  // bare /k8s/ns/<ns>/pods list), inject three direct-jump buttons next to
  // each pod name so you skip the Details tab entirely.

  const POD_ACTIONS = [
    { label: 'Terminal', path: '/terminal', color: '#10b981', featureKey: 'podTerminal' },
    { label: 'Logs',     path: '/logs',     color: '#3b82f6', featureKey: 'podLogs'     },
    { label: 'Events',   path: '/events',   color: '#a855f7', featureKey: 'podEvents'   },
  ];

  function isPodsListPath(pathname) {
    // Catches:
    //   /k8s/ns/<ns>/pods                                (pods list in ns)
    //   /k8s/all-namespaces/pods                         (pods list, all ns)
    //   /k8s/ns/<ns>/<kind>/<name>/pods                  (workload → pods tab)
    //   /k8s/cluster/<cluster-scoped-kind>/<name>/pods   (rare, cluster-scoped)
    return /^\/k8s\/.*\/pods\/?$/.test(pathname);
  }

  function extractPodDetailPath(href) {
    // Must be EXACTLY /k8s/ns/<ns>/pods/<name> (optional trailing slash and
    // optional query/hash) — NOT /k8s/ns/<ns>/pods (list) and NOT any
    // sub-path like /k8s/ns/<ns>/pods/<name>/logs. Matching /<name>/logs
    // would be catastrophic: our own injected Terminal/Logs/Events anchors
    // would match, and we'd recursively inject more buttons every frame.
    const m = (href || '').match(/^(\/k8s\/ns\/[^/?#]+\/pods\/[^/?#]+)\/?([?#]|$)/);
    return m ? m[1] : null;
  }

  function buildPodActionGroup(podPath) {
    // Extract namespace + pod name from the canonical detail path so the
    // Force Delete button can target the right resource.
    const pathMatch = podPath.match(/^\/k8s\/ns\/([^/]+)\/pods\/([^/?#]+)$/);
    const namespace = pathMatch ? pathMatch[1] : null;
    const podName   = pathMatch ? pathMatch[2] : null;

    // Block-level so it sits on its own line below the pod-name link,
    // rather than competing with it for horizontal space in the Name column.
    const wrap = document.createElement('div');
    wrap.className = 'oc-pilot-pod-actions';
    // Stamp the pod path so injectPodActions can detect stale groups when the
    // virtualized table reuses a DOM row for a different pod after a deletion.
    wrap.dataset.podPath = podPath;
    wrap.setAttribute('style', [
      'display:flex',
      'flex-wrap:wrap',
      'align-items:center',
      'gap:4px',
      'margin-top:4px',
    ].join(';'));

    POD_ACTIONS.forEach(({ label, path, color, featureKey }) => {
      if (!FEATURES[featureKey]) return;
      const a = document.createElement('a');
      a.href = podPath + path;
      a.textContent = label;
      a.title = label + ' — ' + podPath.split('/').pop();
      a.setAttribute('style', [
        'display:inline-flex',
        'align-items:center',
        'padding:1px 7px',
        'font-size:10.5px',
        'font-weight:600',
        'letter-spacing:0.02em',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'background:#0f1117',
        'color:#e5e7eb',
        'border:1px solid rgba(255,255,255,0.14)',
        `border-left:3px solid ${color}`,
        'border-radius:3px',
        'text-decoration:none',
        'line-height:1.55',
        'white-space:nowrap',
        'transition:background 0.15s,border-color 0.15s',
      ].join(';'));
      a.addEventListener('mouseenter', () => {
        a.style.background = '#1e2130';
        a.style.borderColor = 'rgba(255,255,255,0.28)';
        a.style.borderLeftColor = color;
      });
      a.addEventListener('mouseleave', () => {
        a.style.background = '#0f1117';
        a.style.borderColor = 'rgba(255,255,255,0.14)';
        a.style.borderLeftColor = color;
      });
      // Don't let the row's click handler (which navigates to pod details) swallow our click.
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        // Map the feature key (podTerminal/podLogs/podEvents) directly to its
        // telemetry event name. Default browser navigation handles the actual
        // route change — we just count the engagement.
        bumpEvent('click.' + featureKey);
      });
      wrap.appendChild(a);
    });

    // Destructive action last, visually separated by a thin divider.
    if (FEATURES.forceDelete && namespace && podName) {
      const sep = document.createElement('span');
      sep.setAttribute('style', [
        'display:inline-block',
        'width:1px',
        'height:14px',
        'background:rgba(255,255,255,0.18)',
        'margin:0 2px',
      ].join(';'));
      wrap.appendChild(sep);
      wrap.appendChild(buildForceDeleteButton(namespace, podName, 'sm'));
    }

    return wrap;
  }

  // ── Pod image-version badge ───────────────────────────────────────────────

  // Extract the human-readable version from a container image reference.
  //
  //   "registry/image:1.2.3"       → "1.2.3"
  //   "image@sha256:<hash>"        → first 7 chars of the hash
  //   "registry:5000/image:latest" → "latest"
  //   "image"                      → null  (no tag)
  function extractImageTag(image) {
    if (!image) return null;
    // Digest reference — show a shortened hash so it's clearly a SHA.
    const digestMatch = image.match(/@sha256:([a-f0-9]+)$/i);
    if (digestMatch) return digestMatch[1].slice(0, 7);
    // Tag reference — split on last colon, but beware "registry:port/image"
    // where the colon is part of the hostname, not a tag separator.
    const lastColon = image.lastIndexOf(':');
    if (lastColon === -1) return null;
    const afterColon = image.substring(lastColon + 1);
    // A slash after the colon means we hit a registry port, not a tag.
    if (afterColon.includes('/')) return null;
    return afterColon || null;
  }

  // Fire-and-forget: fetch the pod's spec from the API, extract the image tag
  // for the first container, and inject a small monospace badge into the group.
  // Guarded by dataset.versionFetched so the virtualized table reuse path
  // never double-fetches the same group element.
  async function fetchAndInjectPodVersion(group) {
    if (!FEATURES.podImageTag) return;
    if (group.dataset.versionFetched) return;
    group.dataset.versionFetched = '1';

    const m = (group.dataset.podPath || '')
      .match(/^\/k8s\/ns\/([^/]+)\/pods\/([^/?#]+)$/);
    if (!m) return;
    const [, namespace, podName] = m;

    let pod;
    try {
      pod = await kFetch(
        `/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`
      );
    } catch (_) { return; }

    const image = pod?.spec?.containers?.[0]?.image;
    const tag   = extractImageTag(image);
    // Bail if we got nothing useful, or if React already unmounted the row.
    if (!tag || !group.isConnected) return;

    const badge = document.createElement('span');
    badge.className = 'oc-pilot-image-tag';
    badge.title     = image || '';   // full image path on hover
    badge.setAttribute('style', [
      'display:inline-flex',
      'align-items:center',
      'padding:1px 6px',
      'font-size:10px',
      'font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace',
      'font-weight:500',
      'background:rgba(255,255,255,0.07)',
      'color:#94a3b8',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:3px',
      'white-space:nowrap',
      'max-width:140px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'line-height:1.55',
      'cursor:default',
    ].join(';'));
    badge.textContent = tag;
    group.appendChild(badge);
    bumpEvent('inject.podImageTag');
    // Re-run the row-height fixer because the badge may have made the cell taller.
    requestAnimationFrame(fixPodRowHeights);
  }

  // Inject a minimal style block (once per page load) — just enough to
  // prevent the cell from clipping our group. Height/layout is fixed by
  // nudging the virtualization library (see nudgeVirtualizedMeasurement).
  function ensurePodActionStyles() {
    if (document.getElementById('oc-pilot-pod-action-style')) return;
    const s = document.createElement('style');
    s.id = 'oc-pilot-pod-action-style';
    s.textContent = [
      'td:has(.oc-pilot-pod-actions),',
      '[role="gridcell"]:has(.oc-pilot-pod-actions),',
      '[role="cell"]:has(.oc-pilot-pod-actions) {',
      '  overflow: visible !important;',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Fix virtualized row heights directly ──────────────────────────────────
  //
  // The pods table uses react-virtualized. Each row is position:absolute with
  // inline `height` and `top` set by the library from a CellMeasurerCache.
  // Our injected buttons make content taller than the cached measurement, so
  // rows overflow into each other until the library re-measures (~10 s when
  // an API update triggers a React re-render).
  //
  // Every attempt to trigger re-measurement (resize event, scroll nudge,
  // fiber-tree cache invalidation) either didn't work or caused React to
  // strip our injected DOM. So we stop fighting the library and just commit
  // the correct heights ourselves:
  //
  //   1. Measure each cell's actual content height via scrollHeight — this
  //      returns true content size even when the row's inline height clips it.
  //   2. Write `height: <measured>px !important` and `top: <cumulative>px !important`
  //      onto each row. `!important` on inline styles beats React's inline
  //      style writes (React's element.style.X = Y is not !important).
  //   3. Update the tbody's height to match the new total so the scroll
  //      container knows the correct content size.
  //
  // Known limitation: for lists long enough to scroll, !important on `top`
  // blocks the library's per-scroll position updates. Acceptable tradeoff
  // — most deployments have <20 pods and fit on screen without scrolling.

  function fixPodRowHeights() {
    const rows = Array.from(document.querySelectorAll(
      'tr[data-key][style*="position: absolute"], ' +
      '[role="row"][data-key][style*="position: absolute"]'
    ));
    if (!rows.length) return;

    let cumulativeTop = 0;
    let changed = false;

    rows.forEach((tr) => {
      const cell = tr.querySelector('td, [role="gridcell"], [role="cell"]');
      if (!cell) return;

      // scrollHeight = full content size, not clipped by inline row height.
      // Falls back to offsetHeight for detached/zero-scroll-height cells.
      const contentHeight = Math.max(cell.scrollHeight, cell.offsetHeight);
      if (contentHeight <= 0) return;

      const currentH = parseFloat(tr.style.height) || 0;
      const currentT = parseFloat(tr.style.top) || 0;
      if (Math.abs(currentH - contentHeight) > 0.5) {
        tr.style.setProperty('height', contentHeight + 'px', 'important');
        changed = true;
      }
      if (Math.abs(currentT - cumulativeTop) > 0.5) {
        tr.style.setProperty('top', cumulativeTop + 'px', 'important');
        changed = true;
      }
      cumulativeTop += contentHeight;
    });

    if (changed) {
      // Update the tbody (or whatever container holds the rows) so the
      // scroll container sizes correctly. Only do this if the parent is the
      // direct tbody / table-body.
      const parent = rows[0].parentElement;
      if (parent && (parent.tagName === 'TBODY' || parent.getAttribute('role') === 'rowgroup')) {
        parent.style.setProperty('height', cumulativeTop + 'px', 'important');
      }
      _dbg(`fixed ${rows.length} virtualized row${rows.length === 1 ? '' : 's'}, total ${cumulativeTop}px`);
    }
  }

  function injectPodActions() {
    if (!FEATURES.podTerminal && !FEATURES.podLogs && !FEATURES.podEvents && !FEATURES.podImageTag) return;
    if (!isPodsListPath(location.pathname)) return;

    ensurePodActionStyles();

    const anchors = document.querySelectorAll('a[href^="/k8s/ns/"]');
    let added = 0;
    anchors.forEach((a) => {
      // Never recurse into our own injected button group.
      if (a.closest('.oc-pilot-pod-actions')) return;

      const href = a.getAttribute('href') || '';
      const podPath = extractPodDetailPath(href);
      if (!podPath) return;

      const cell = a.closest('td, [role="gridcell"], [role="cell"]');
      if (!cell) return;

      // Staleness check: the virtualized table reuses DOM rows when the list
      // changes (e.g. after a pod is deleted the next pod slides into the same
      // <tr>). If the existing group's data-pod-path doesn't match the current
      // link, remove it and re-inject — otherwise the buttons target the wrong pod.
      const existingGroup = cell.querySelector('.oc-pilot-pod-actions');
      if (existingGroup) {
        if (existingGroup.dataset.podPath === podPath) return; // same pod — skip
        existingGroup.remove(); // stale — replace with fresh buttons below
      }

      const group = buildPodActionGroup(podPath);
      cell.appendChild(group);
      fetchAndInjectPodVersion(group); // fire-and-forget
      added++;
    });

    if (added) {
      _dbg(`✓ injected actions on ${added} pod row${added === 1 ? '' : 's'}`);
      // Fire after the browser has committed our DOM insertions so the
      // measurement reflects the new content.
      requestAnimationFrame(fixPodRowHeights);
    }
  }

  function clearPodActions() {
    // .oc-pilot-actions-row cleanup is for legacy state from 0.20.4 — safe to
    // keep so users upgrading don't end up with stranded rows.
    document.querySelectorAll('.oc-pilot-actions-row').forEach((el) => el.remove());
    document.querySelectorAll('.oc-pilot-pod-actions').forEach((el) => el.remove());
  }

  // Debounced pod-action injector.
  //
  // Pod lists render in stages (API pod status updates arrive over several
  // seconds), so MutationObserver fires a lot. A short debounce smooths that
  // out — we want to let React finish its current render pass before checking
  // which cells need injection.
  //
  // CRITICAL: do NOT clear-then-inject here. That used to be in this function
  // and created a feedback loop: the clear+inject themselves produce mutations,
  // which retrigger the observer, which reschedule this debounce. Result: the
  // "injected actions on N pods" log prints forever every 400 ms.
  //
  // Instead, rely on `injectPodActions` being idempotent (its per-cell
  // querySelector dedup skips already-injected cells). When all cells have
  // their group, the call is a no-op — no DOM changes, no retriggering.
  let _podActionsTimer = null;
  function schedulePodActionsInject() {
    clearTimeout(_podActionsTimer);
    _podActionsTimer = setTimeout(injectPodActions, 400);
  }

  // ── Resource Favourites ───────────────────────────────────────────────────
  // Stored under "ocPilotFavourites" (separate from openshiftAutoLogin so
  // favourites survive a credential clear).
  //
  // Shape: { [hostname]: { [namespace]: { [kind]: string[] } } }
  // Namespace key "__cluster__" covers cluster-scoped and all-namespaces views.

  let _favs = {};
  let _favsLoaded = false;

  // ── Persistent column sort ────────────────────────────────────────────────
  // Stored under "ocPilotSortPrefs" (separate key so it survives credential
  // clears, same pattern as ocPilotFavourites).
  //
  // Shape: { [hostname]: { [resourceKind]: { column: string, direction: "asc"|"desc" } } }
  //   resourceKind — from parseResourceListUrl().resourceKind (e.g. "pods")
  //   column       — sort button's visible text (e.g. "Created")
  //   direction    — "asc" or "desc"
  let _sortPrefs = {};
  let _sortPrefsLoaded = false;
  let _sortPollTimer = null;
  let _sortSaveTimer = null;
  // Prevents concurrent calls to _applySortPreference when OKD's replaceState
  // fires onNavigate() mid-restore and restarts the poll.
  let _sortRestoreInProgress = false;

  // ── Cluster toolbar colour ─────────────────────────────────────────────────
  // Stored in "ocPilotClusterColours" as { [hostname]: "#hex" }.
  // null means "use OCP's default dark masthead".
  let _clusterColour = null;

  function loadClusterColour() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('ocPilotClusterColours', (data) => {
          const map = ((data || {}).ocPilotClusterColours) || {};
          _clusterColour = map[location.hostname] || null;
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  // Injects (or updates / removes) a <style> tag that overrides the masthead
  // background.  Idempotent — safe to call multiple times.
  function applyToolbarColour() {
    const STYLE_ID = 'oc-pilot-masthead-colour';
    let el = document.getElementById(STYLE_ID);
    if (!_clusterColour) {
      if (el) el.remove(); // revert to OCP default
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    // PF5 (OCP 4.12+): the masthead background is painted by the inner
    // .pf-v5-c-toolbar, which has its own background-color and covers the
    // masthead's own background. Both elements need the colour rule.
    // PF4 fallback (.pf-c-page__header / .pf-c-toolbar) for older consoles.
    const c = _clusterColour;
    el.textContent = [
      `.pf-v5-c-masthead{background-color:${c}!important;}`,
      `.pf-v5-c-masthead .pf-v5-c-toolbar{background-color:${c}!important;}`,
      `.pf-c-page__header{background-color:${c}!important;}`,
      `.pf-c-page__header .pf-c-toolbar{background-color:${c}!important;}`,
    ].join('');
  }

  async function loadFavourites() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('ocPilotFavourites', (data) => {
          _favs = (data || {}).ocPilotFavourites || {};
          _favsLoaded = true;
          resolve();
        });
      } catch (_) { _favsLoaded = true; resolve(); }
    });
  }

  async function saveFavourites() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ ocPilotFavourites: _favs }, resolve);
      } catch (_) { resolve(); }
    });
  }

  function isFavourite(ns, kind, name) {
    const cluster = location.hostname;
    return !!(_favs[cluster] && _favs[cluster][ns] &&
      (_favs[cluster][ns][kind] || []).includes(name));
  }

  function getFavouritesForKind(ns, kind) {
    const cluster = location.hostname;
    return ((_favs[cluster] || {})[ns] || {})[kind] || [];
  }

  async function toggleFavourite(ns, kind, name) {
    const cluster = location.hostname;
    if (!_favs[cluster]) _favs[cluster] = {};
    if (!_favs[cluster][ns]) _favs[cluster][ns] = {};
    if (!_favs[cluster][ns][kind]) _favs[cluster][ns][kind] = [];
    const arr = _favs[cluster][ns][kind];
    const idx = arr.indexOf(name);
    if (idx === -1) {
      arr.push(name);
      arr.sort();
    } else {
      arr.splice(idx, 1);
      if (arr.length === 0) {
        delete _favs[cluster][ns][kind];
        if (Object.keys(_favs[cluster][ns]).length === 0) {
          delete _favs[cluster][ns];
          if (Object.keys(_favs[cluster]).length === 0) delete _favs[cluster];
        }
      }
    }
    await saveFavourites();
  }

  // Maps GVK URL segments (group~version~Kind) used by some on-premise OpenShift
  // consoles to the canonical plural kind names used in row anchor hrefs and
  // therefore in favourites storage keys.  Unknown kinds pass through unchanged.
  const _GVK_KIND_MAP = {
    'apps~v1~Deployment':                   'deployments',
    'apps~v1~ReplicaSet':                   'replicasets',
    'apps~v1~StatefulSet':                  'statefulsets',
    'apps~v1~DaemonSet':                    'daemonsets',
    // Core group — OKD console uses both "v1~Kind" and "core~v1~Kind" forms
    'v1~Pod':                               'pods',
    'core~v1~Pod':                          'pods',
    'v1~Service':                           'services',
    'core~v1~Service':                      'services',
    'v1~ConfigMap':                         'configmaps',
    'core~v1~ConfigMap':                    'configmaps',
    'v1~Secret':                            'secrets',
    'core~v1~Secret':                       'secrets',
    'v1~ServiceAccount':                    'serviceaccounts',
    'core~v1~ServiceAccount':               'serviceaccounts',
    'v1~PersistentVolumeClaim':             'persistentvolumeclaims',
    'core~v1~PersistentVolumeClaim':        'persistentvolumeclaims',
    'v1~PersistentVolume':                  'persistentvolumes',
    'core~v1~PersistentVolume':             'persistentvolumes',
    'v1~Node':                              'nodes',
    'core~v1~Node':                         'nodes',
    'v1~Namespace':                         'namespaces',
    'core~v1~Namespace':                    'namespaces',
    'batch~v1~Job':                         'jobs',
    'batch~v1~CronJob':                     'cronjobs',
    'route.openshift.io~v1~Route':          'routes',
    'networking.k8s.io~v1~Ingress':         'ingresses',
    'networking.k8s.io~v1~NetworkPolicy':   'networkpolicies',
    'storage.k8s.io~v1~StorageClass':       'storageclasses',
    'rbac.authorization.k8s.io~v1~Role':    'roles',
    'rbac.authorization.k8s.io~v1~ClusterRole': 'clusterroles',
    'rbac.authorization.k8s.io~v1~RoleBinding': 'rolebindings',
    'rbac.authorization.k8s.io~v1~ClusterRoleBinding': 'clusterrolebindings',
    'apps.openshift.io~v1~DeploymentConfig':'deploymentconfigs',
    'image.openshift.io~v1~ImageStream':    'imagestreams',
    'build.openshift.io~v1~BuildConfig':    'buildconfigs',
    'build.openshift.io~v1~Build':          'builds',
  };
  function normalizeResourceKind(kind) {
    return _GVK_KIND_MAP[kind] || kind;
  }

  // Resource kinds that support the favourites feature (stars + pinned section).
  // Intentionally limited to stable, named resources. Ephemeral resources like
  // pods are excluded because their names change on every restart, making a
  // saved favourite useless after the next rollout.
  const FAVOURITE_KINDS = new Set([
    'deployments',
    'deploymentconfigs',
    'routes',
    'configmaps',
    'secrets',
    'cronjobs',
    'services',
  ]);

  // Detect a resource LIST page: /k8s/(ns/<ns>|all-namespaces|cluster)/<kind>
  // Must end at the kind segment — no resource name after it.
  function parseResourceListUrl(pathname) {
    const m = pathname.match(
      /^\/k8s\/(?:ns\/([^/]+)|all-namespaces|(cluster))\/([\w.~-]+)\/?$/
    );
    if (!m) return null;
    const rawKind = m[3];
    if (/^[~]/.test(rawKind) ||
        ['project-details', 'overview'].includes(rawKind)) return null;
    return { namespace: m[1] || '__cluster__', resourceKind: normalizeResourceKind(rawKind) };
  }

  // Parse a resource detail href into its components. Works for both list-page
  // anchor hrefs and the current location.pathname (sub-pages are ignored).
  function parseResourceDetailHref(href) {
    // First char of name segment must not be ~ (create/form pages like ~new).
    // Kind segment uses [\w.~-]+ (includes ~ for GVK format URLs like
    // /k8s/ns/default/v1~ConfigMap/my-config or apps~v1~Deployment/my-deploy).
    const m = (href || '').match(
      /^\/k8s\/(?:ns\/([^/?#]+)|cluster)\/([\w.~-]+)\/([^/?#~][^/?#]*)/
    );
    if (!m) return null;
    const rawKind = m[2];
    if (/^[~]/.test(rawKind) ||
        ['project-details', 'overview'].includes(rawKind)) return null;
    const ns = m[1] || '__cluster__';
    // m[3] stops at the first / due to [^/?#]* so no further split needed, but
    // guard just in case (regex should already handle this).
    const rawName = m[3].split('/')[0];
    let resourceName;
    try { resourceName = decodeURIComponent(rawName); } catch (_) { resourceName = rawName; }
    return {
      namespace:    ns,
      resourceKind: normalizeResourceKind(rawKind),
      resourceName,
      // Keep raw kind in the navigation path so links still work.
      path: `/k8s/${m[1] ? 'ns/' + m[1] : 'cluster'}/${m[2]}/${rawName}`,
    };
  }

  // Build a star SVG element (filled amber or hollow grey).
  // pointer-events:none is critical — it makes the parent <button> the click
  // target instead of the SVG.  Without this, a capture-phase listener on the
  // button sees the SVG as the target (a child), calls stopPropagation() during
  // the capture phase, and the event never reaches the SVG target, so the
  // button's own bubble-phase handler never fires ("nothing happens" on click).
  function buildStarSvg(filled) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', filled ? '#f59e0b' : 'none');
    svg.setAttribute('stroke', filled ? '#f59e0b' : '#6b7280');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.pointerEvents = 'none'; // let the parent button be the event target
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points',
      '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
    svg.appendChild(poly);
    return svg;
  }

  // Update the star icon and tooltip inside a .oc-pilot-star-wrap span.
  function updateStarIcon(wrap, isFav) {
    const btn = wrap.querySelector('button');
    if (!btn) return;
    const oldSvg = btn.querySelector('svg');
    if (oldSvg) oldSvg.replaceWith(buildStarSvg(isFav));
    btn.title = isFav ? 'Remove from favourites' : 'Add to favourites';
  }

  // Debounced star injector (200 ms — tighter than pod actions' 400 ms).
  let _starInjectTimer = null;
  function scheduleStarInject() {
    clearTimeout(_starInjectTimer);
    _starInjectTimer = setTimeout(injectFavouriteStars, 200);
  }

  function injectFavouriteStars() {
    if (!FEATURES.favourites) return;
    if (!_favsLoaded) return;
    const _listInfo = parseResourceListUrl(location.pathname);
    if (!_listInfo) return;
    // Only inject stars on resource types that support favourites.
    if (!FAVOURITE_KINDS.has(_listInfo.resourceKind)) return;

    const anchors = document.querySelectorAll(
      'a[href^="/k8s/ns/"], a[href^="/k8s/cluster/"]'
    );
    anchors.forEach((a) => {
      // Never process links inside our own injected elements (pinned section,
      // star-wraps, pod-action groups).  Without the pinned-wrapper guard,
      // injectFavouriteStars would call updateStarIcon on the pinned rows'
      // name-links and flip their star icons to the current _favs state —
      // which could turn amber pinned stars hollow if the lookup key mismatches.
      if (
        a.closest('#oc-pilot-pinned-table-wrapper') ||
        a.closest('.oc-pilot-star-wrap') ||
        a.closest('.oc-pilot-pod-actions')
      ) return;

      const href = a.getAttribute('href') || '';
      const parsed = parseResourceDetailHref(href);
      if (!parsed) return;
      // Guard per-anchor too (handles cross-kind links on a page).
      if (!FAVOURITE_KINDS.has(parsed.resourceKind)) return;

      const cell = a.closest('td, [role="gridcell"], [role="cell"]');
      if (!cell) return;

      // Only inject stars in the FIRST data cell that contains a /k8s/ resource
      // link (i.e. the Name column). Using "first <td> in the row" breaks on
      // tables that have a leading checkbox/select column — the checkbox cell is
      // the first <td> but contains no resource link, so the Name cell (second
      // <td>) would always be skipped.  Finding the first cell WITH a resource
      // link is robust regardless of how many non-link columns precede the Name.
      const row = a.closest('tr, [role="row"]');
      const allCells = row
        ? [...row.querySelectorAll('td, [role="gridcell"], [role="cell"]')]
        : [];
      const firstLinkCell = allCells.find(
        c => c.querySelector('a[href^="/k8s/ns/"], a[href^="/k8s/cluster/"]')
      );
      if (!firstLinkCell || firstLinkCell !== cell) return;

      const starPath = parsed.path;

      // Staleness check: virtualised rows reuse DOM nodes — if the path
      // changed (e.g. after a resource is deleted), remove and re-inject.
      const existing = cell.querySelector('.oc-pilot-star-wrap');
      if (existing) {
        if (existing.dataset.starPath === starPath) {
          // Same resource — but the favourite state may have changed while
          // this row was virtualised out (e.g. the user clicked ✕ in the
          // pinned section to remove it). Refresh the icon to match the
          // current state instead of skipping; otherwise a stale amber star
          // would remain on a row that's no longer favourited.
          const nowFav = isFavourite(
            parsed.namespace, parsed.resourceKind, parsed.resourceName
          );
          updateStarIcon(existing, nowFav);
          return;
        }
        existing.remove(); // stale — replace with fresh star below
      }

      // Row-level dedup: multiple anchors in the same first cell (icon + name link).
      if (row && row.querySelector(`.oc-pilot-star-wrap[data-star-path="${starPath}"]`)) return;

      // Ensure the cell is a positioning context (it usually already is in PF5).
      if (window.getComputedStyle(cell).position === 'static') {
        cell.style.position = 'relative';
      }

      const wrap = document.createElement('span');
      wrap.className = 'oc-pilot-star-wrap';
      wrap.dataset.starPath = starPath;
      // Absolutely positioned in the cell's left-padding area so it never
      // shifts the row's text content — not even during the inject delay.
      // top = padding-top(8px) + (line-height(21px) - star-height(14px)) / 2 ≈ 11px.
      // A fixed top (not 50%) keeps the star aligned with the first text line
      // even in tall rows caused by wrapping label tags.
      wrap.setAttribute('style', [
        'position:absolute',
        'left:3px',
        'top:11px',
        'display:inline-flex',
        'align-items:center',
        'z-index:1',
      ].join(';'));

      const fav = isFavourite(parsed.namespace, parsed.resourceKind, parsed.resourceName);
      const btn = document.createElement('button');
      btn.title = fav ? 'Remove from favourites' : 'Add to favourites';
      btn.setAttribute('style', [
        'background:none',
        'border:none',
        'padding:0',
        'cursor:pointer',
        'display:inline-flex',
        'align-items:center',
        'opacity:0.5',
        'transition:opacity 0.15s,transform 0.15s',
        'line-height:1',
      ].join(';'));
      btn.appendChild(buildStarSvg(fav));

      btn.addEventListener('mouseenter', () => {
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1.15)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.opacity = '0.5';
        btn.style.transform = '';
      });
      // Single bubble-phase listener only.
      // DO NOT add a capture-phase listener here: in Chrome, calling
      // stopPropagation() in a capture listener at the target element blocks
      // all bubble-phase listeners on that SAME element (tested empirically —
      // Chrome treats stopPropagation at-target as stopping the entire at-target
      // phase for subsequent listeners).  The SVG inside the button has
      // pointer-events:none (set in buildStarSvg) so the button itself is always
      // the event target, and stopPropagation() in this bubble handler is enough
      // to prevent the click from reaching any row-level handlers.
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        _dbg('star click (list):', parsed.namespace, parsed.resourceKind, parsed.resourceName);
        try {
          const wasFav = isFavourite(parsed.namespace, parsed.resourceKind, parsed.resourceName);
          bumpEvent(wasFav ? 'click.favourites.remove' : 'click.favourites.add');
          await toggleFavourite(parsed.namespace, parsed.resourceKind, parsed.resourceName);
          const nowFav = isFavourite(parsed.namespace, parsed.resourceKind, parsed.resourceName);
          _dbg('star toggled → isFav:', nowFav);
          btn.title = nowFav ? 'Remove from favourites' : 'Add to favourites';
          const oldSvg = btn.querySelector('svg');
          if (oldSvg) oldSvg.replaceWith(buildStarSvg(nowFav));
          injectPinnedSection();
        } catch (err) {
          console.error(LOG, 'star click error:', err);
        }
      });

      wrap.appendChild(btn);
      // Append directly to the cell (not inline before the anchor) so the
      // absolute positioning is relative to the cell, not to inline flow.
      cell.appendChild(wrap);
    });
  }

  // Build a minimal pinned-section row from just the resource identity, used
  // when neither a live DOM row nor a cached clone is available (e.g. on first
  // page load when ReactVirtualized has only rendered rows 0–30 but the user
  // has favourites further down). The first cell gets star + name link; later
  // cells are dim "—" placeholders so column widths stay aligned with the
  // main table. Once the user scrolls and the real row enters the live DOM,
  // the next injectPinnedSection call replaces this synthetic row with a
  // rich clone via the matched-row preference order.
  // Build a synthetic pinned row for a favourite that has no live DOM row
  // (e.g. below the initial virtualised render window on page load).
  // Uses a single colspan="100" cell — no broken column alignment from
  // mismatched <td> widths, intentionally minimal: star · name · namespace.
  // Once the user scrolls the real row into view, upgradeSyntheticPinnedRows
  // triggers a rebuild that replaces this with a rich clone.
  function buildSyntheticPinnedRow(namespace, kind, name, onStarClick) {
    const tr = document.createElement('tr');
    tr.className = 'pf-v5-c-table__tr';   // needed for PF5's padding CSS rule
    tr.dataset.ocPilotIsClone   = '1';
    tr.dataset.ocPilotSynthetic = '1';
    tr.style.borderLeft = '3px solid #f59e0b';

    const path = '/k8s/ns/' + namespace + '/' + kind + '/' + name;

    // Convert plural URL kind ("deployments", "pods") → singular CSS class
    // suffix ("deployment", "pod") used by OKD's resource-icon styling.
    const kindSingular = kind.endsWith('s') ? kind.slice(0, -1) : kind;
    const kindLabel    = kindSingular.charAt(0).toUpperCase() + kindSingular.slice(1);
    const iconLetter   = (kindLabel[0] || 'R').toUpperCase();

    // ── Star wrap ────────────────────────────────────────────────────────────
    // Must be position:absolute (same as injectFavouriteStars) so it sits in
    // the cell's left-padding area without displacing the resource-item span
    // (which is display:flex / block-level and would push an in-flow star to
    // its own line).
    const starWrap = document.createElement('span');
    starWrap.className = 'oc-pilot-star-wrap';
    starWrap.dataset.starPath = path;
    starWrap.setAttribute('style', [
      'position:absolute',
      'left:3px',
      'top:11px',
      'display:inline-flex',
      'align-items:center',
      'z-index:1',
    ].join(';'));
    const starBtn = document.createElement('button');
    starBtn.title = 'Remove from favourites';
    starBtn.setAttribute('style', [
      'background:none',
      'border:none',
      'padding:0',
      'cursor:pointer',
      'display:inline-flex',
      'align-items:center',
      'opacity:0.85',
      'line-height:1',
    ].join(';'));
    starBtn.appendChild(buildStarSvg(true));
    starBtn.addEventListener('click', onStarClick);
    starWrap.appendChild(starBtn);

    // ── Helper: build a co-resource-item span (badge + link) ─────────────────
    // Mirrors OKD's structure so the synthetic row gets the same "D"/"NS"
    // colored badge and link styling as live rows.
    const buildResourceItem = (kindLbl, iconLtr, iconClsSuffix, href, text) => {
      const wrap = document.createElement('span');
      wrap.className = 'co-resource-item';

      const sr = document.createElement('span');
      sr.className = 'pf-v5-u-screen-reader';
      sr.textContent = kindLbl;
      wrap.appendChild(sr);

      const icon = document.createElement('span');
      icon.className = 'co-m-resource-icon co-m-resource-' + iconClsSuffix;
      icon.textContent = iconLtr;
      wrap.appendChild(icon);

      const a = document.createElement('a');
      a.className = 'co-resource-item__resource-name';
      a.href = href;
      a.textContent = text;
      wrap.appendChild(a);

      return wrap;
    };

    // ── Name cell ────────────────────────────────────────────────────────────
    const nameTd = document.createElement('td');
    nameTd.className = 'pf-v5-c-table__td';
    // position:relative is required so the absolute star stays inside this cell.
    nameTd.setAttribute('style', 'position:relative;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    nameTd.appendChild(starWrap);
    nameTd.appendChild(buildResourceItem(kindLabel, iconLetter, kindSingular, path, name));
    tr.appendChild(nameTd);

    // ── Mirror remaining columns from the main table header ──────────────────
    const mainThead = document.querySelector(
      'table:not(#oc-pilot-pinned-table-wrapper table) thead tr'
    );
    const thCells = mainThead ? [...mainThead.querySelectorAll('th, td')] : [];

    if (thCells.length > 1) {
      // Skip the first <th> — that's the Name column we already built.
      thCells.slice(1).forEach(th => {
        const label = (th.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const td = document.createElement('td');
        td.className = 'pf-v5-c-table__td';
        if (label.startsWith('namespace') || th.dataset.label === 'Namespace') {
          td.classList.add('co-break-word');
          td.appendChild(buildResourceItem(
            'Namespace', 'NS', 'namespace',
            '/k8s/cluster/projects/' + namespace,
            namespace,
          ));
        } else if (label === '' || label === ' ') {
          // Actions / kebab column — leave empty
        } else {
          // All other columns (Status, Labels, Pod selector…) — em-dash placeholder
          td.textContent = '—';
          td.setAttribute('style', 'color:rgba(255,255,255,0.25);');
        }
        tr.appendChild(td);
      });
    } else {
      // No header found yet (table still loading) — fall back to colspan cell.
      tr.removeChild(nameTd);
      const fallbackTd = document.createElement('td');
      fallbackTd.className = 'pf-v5-c-table__td';
      fallbackTd.setAttribute('colspan', '100');
      fallbackTd.setAttribute('style', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
      fallbackTd.appendChild(starWrap);
      fallbackTd.appendChild(buildResourceItem(kindLabel, iconLetter, kindSingular, path, name));
      const sep = document.createElement('span');
      sep.textContent = ' · ';
      sep.setAttribute('style', 'color:#6b7280;margin:0 6px;');
      fallbackTd.appendChild(sep);
      fallbackTd.appendChild(buildResourceItem(
        'Namespace', 'NS', 'namespace',
        '/k8s/cluster/projects/' + namespace,
        namespace,
      ));
      tr.appendChild(fallbackTd);
    }

    return tr;
  }

  // Triggers a pinned-section rebuild when at least one synthetic row in the
  // pinned table now has a matching live row in the main (virtualized) table —
  // typically because the user scrolled and ReactVirtualized re-rendered that
  // row. The rebuild's match preference (live > cached > synthetic) replaces
  // the synthetic with a rich clone, so the pinned row gains its real status,
  // labels, etc. Self-terminating: once no synthetics have live counterparts,
  // we stop calling injectPinnedSection so there's no rebuild loop.
  function upgradeSyntheticPinnedRows() {
    const wrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
    if (!wrapper) return;
    const synthetics = wrapper.querySelectorAll('tr[data-oc-pilot-synthetic="1"]');
    if (!synthetics.length) return;

    // Build the set of live row star-paths once (outside our wrapper).
    const livePaths = new Set();
    document.querySelectorAll('.oc-pilot-star-wrap[data-star-path]').forEach((s) => {
      if (s.closest('#oc-pilot-pinned-table-wrapper')) return;
      livePaths.add(s.dataset.starPath);
    });

    for (const tr of synthetics) {
      const w = tr.querySelector('.oc-pilot-star-wrap[data-star-path]');
      if (!w) continue;
      if (livePaths.has(w.dataset.starPath)) {
        injectPinnedSection();
        return; // one rebuild upgrades all upgradable synthetics at once
      }
    }
  }

  // ── ReactVirtualized scroll-position repair ────────────────────────────────
  //
  // The actual patching runs in content-console-rv.js which is declared with
  // "world": "MAIN" in the manifest, giving it direct access to page-world
  // React instances. This isolated-world script cannot:
  //   • modify page-world objects via Object.defineProperty (mutations are
  //     invisible across the cross-world proxy boundary)
  //   • inject inline <script> tags (CSP blocks 'unsafe-inline')
  //   • reach page window listeners via window.dispatchEvent (isolated window)
  //
  // Communication: dispatch a CustomEvent on the shared DOM. The MAIN-world
  // script listens for 'oc-pilot:rv-sync' and performs:
  //   1. __handleWindowScrollEvent() — immediately resyncs state.scrollTop
  //   2. Object.defineProperty on _positionFromTop — so every future
  //      updatePosition() call (from _detectElementResize, _onResize, etc.)
  //      also resyncs state.scrollTop automatically.

  // Deferred, deduplicated layout notification for ReactVirtualized.
  // Using rAF means the DOM has fully settled before we ask the MAIN-world
  // script to resync. The flag prevents double-fires within the same frame.
  let _rvResizeScheduled = false;
  function _scheduleRvResize() {
    if (_rvResizeScheduled) return;
    _rvResizeScheduled = true;
    requestAnimationFrame(() => {
      _rvResizeScheduled = false;
      // Pass the current pinned-section height so the MAIN-world script can
      // skip updatePosition() / refreshScrollState() when nothing has grown
      // (e.g. virtualizer row re-renders during normal scrolling also trigger
      // MutationObserver → scheduleInject → _scheduleRvResize; without this
      // guard those no-op syncs cause state.scrollTop to go stale → blank space).
      const wrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
      const pinnedHeight = wrapper ? wrapper.offsetHeight : 0;
      // Signal the MAIN-world script (content-console-rv.js) to resync
      // state.scrollTop and install the _positionFromTop interceptor.
      document.dispatchEvent(new CustomEvent('oc-pilot:rv-sync', { detail: { pinnedHeight } }));
    });
  }

  // ── API-based enrichment for synthetic pinned rows ───────────────────────────
  // When a favourite row is not in the ReactVirtualized viewport (common in
  // all-namespaces views with hundreds of rows), we can't clone it.  Instead we
  // fetch the resource from the Kube API proxy the OKD console exposes at
  // /api/kubernetes/ and populate Status / Labels / Pod-selector in-place.
  // This fires asynchronously after injectPinnedSection so the section appears
  // immediately and fills in progressively.

  // URL segment for each resource kind → "apis/group/version" or "api/v1"
  const _KIND_API_BASE = {
    deployments:            'apis/apps/v1',
    replicasets:            'apis/apps/v1',
    statefulsets:           'apis/apps/v1',
    daemonsets:             'apis/apps/v1',
    pods:                   'api/v1',
    services:               'api/v1',
    configmaps:             'api/v1',
    secrets:                'api/v1',
    serviceaccounts:        'api/v1',
    persistentvolumeclaims: 'api/v1',
    jobs:                   'apis/batch/v1',
    cronjobs:               'apis/batch/v1',
    routes:                 'apis/route.openshift.io/v1',
    ingresses:              'apis/networking.k8s.io/v1',
  };

  function _htmlEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function _fetchKubeResource(apiBase, namespace, kind, name) {
    const path = namespace === '__cluster__'
      ? `/api/kubernetes/${apiBase}/${kind}/${name}`
      : `/api/kubernetes/${apiBase}/namespaces/${namespace}/${kind}/${name}`;
    const resp = await fetch(path, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  function _buildStatusCellContent(resource, namespace, kind, name) {
    if (['deployments', 'replicasets', 'statefulsets'].includes(kind)) {
      const ready = resource.status?.readyReplicas ?? 0;
      const total = resource.status?.replicas ?? 0;
      const href  = `/k8s/ns/${namespace}/${kind}/${name}/pods`;
      return `<a title="pods" href="${_htmlEsc(href)}">${ready} of ${total} pods</a>`;
    }
    if (kind === 'daemonsets') {
      const ready = resource.status?.numberReady ?? 0;
      const total = resource.status?.desiredNumberScheduled ?? 0;
      return `${ready} of ${total} pods`;
    }
    if (kind === 'pods') {
      return _htmlEsc(resource.status?.phase || '');
    }
    return '';
  }

  function _buildLabelsCellContent(labels) {
    const entries = Object.entries(labels || {});
    if (!entries.length) {
      return '<span style="color:rgba(255,255,255,0.35)">No labels</span>';
    }
    const items = entries.map(([k, v]) => {
      const text = v !== undefined ? `${k}=${v}` : k;
      return `<li class="pf-v5-c-label-group__list-item">` +
        `<span class="pf-v5-c-label pf-m-compact co-label">` +
        `<span class="pf-v5-c-label__content">` +
        `<span class="pf-v5-c-label__text">${_htmlEsc(text)}</span>` +
        `</span></span></li>`;
    }).join('');
    return `<div class="pf-v5-c-label-group co-label-group">` +
      `<div class="pf-v5-c-label-group__main">` +
      `<ul class="pf-v5-c-label-group__list" aria-label="Label group category" role="list" data-test="label-list">` +
      items + `</ul></div></div>`;
  }

  function _buildSelectorCellContent(resource, namespace, kind, name) {
    const ml = resource.spec?.selector?.matchLabels || {};
    const entries = Object.entries(ml);
    if (!entries.length) return '';
    const text = entries.map(([k, v]) => v !== undefined ? `${k}=${v}` : k).join(', ');
    const href = `/k8s/ns/${namespace}/${kind}/${name}/pods`;
    // Magnify-glass SVG matching OKD's icon size/style
    const icon = `<svg viewBox="0 0 512 512" fill="currentColor" style="width:0.9em;height:0.9em;vertical-align:-0.1em;margin-right:4px;opacity:0.7">` +
      `<path d="M508.5 481.6l-129-129a12 12 0 0 0-8.5-3.5h-10.3C395 312 416 262.5 416 208 416 93.1 322.9 0 208 0S0 93.1 0 208s93.1 208 208 208c54.5 0 104-21 141.1-55.2V371a12 12 0 0 0 3.5 8.5l129 129c4.7 4.7 12.3 4.7 17 0l9.9-9.9c4.7-4.7 4.7-12.3 0-17zM208 384c-97.3 0-176-78.7-176-176S110.7 32 208 32s176 78.7 176 176-78.7 176-176 176z"/>` +
      `</svg>`;
    return `<a class="co-m-selector-link" href="${_htmlEsc(href)}" title="${_htmlEsc(text)}">${icon}${_htmlEsc(text)}</a>`;
  }

  let _enrichAbortCtl = null;

  // Asynchronously fill in Status / Labels / Pod-selector for every synthetic
  // pinned row by fetching data from the Kube API.  Safe to call repeatedly —
  // each call cancels the previous in-flight enrichment.
  async function enrichSyntheticPinnedRows() {
    if (!FEATURES.favourites) return;

    if (_enrichAbortCtl) _enrichAbortCtl.abort();
    _enrichAbortCtl = new AbortController();
    const { signal } = _enrichAbortCtl;

    const wrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
    if (!wrapper) return;

    // Map column index → header label (lower-case) from the main table header.
    const headerLabels = [
      ...document.querySelectorAll(
        'table:not(#oc-pilot-pinned-table-wrapper table) thead tr th,' +
        'table:not(#oc-pilot-pinned-table-wrapper table) thead tr td'
      ),
    ].map(th => th.textContent.trim().toLowerCase());

    const synthetics = [...wrapper.querySelectorAll('tr[data-oc-pilot-synthetic="1"]')];
    if (!synthetics.length) return;

    await Promise.all(synthetics.map(async (tr) => {
      if (signal.aborted) return;

      const starWrap = tr.querySelector('.oc-pilot-star-wrap');
      if (!starWrap) return;
      const parsed = parseResourceDetailHref(starWrap.dataset.starPath);
      if (!parsed) return;

      const { namespace, resourceKind: kind, resourceName: name } = parsed;
      const apiBase = _KIND_API_BASE[kind];
      if (!apiBase) return; // unknown kind — leave as —

      let resource;
      try {
        resource = await _fetchKubeResource(apiBase, namespace, kind, name);
      } catch (_) {
        return; // network/auth error — leave as —
      }

      if (signal.aborted) return;
      if (!tr.isConnected) return; // row was removed by a rebuild

      const tds = [...tr.querySelectorAll('td')];
      tds.forEach((td, i) => {
        if (i === 0) return; // Name cell (star + resource link) — leave as-is
        const hdr = headerLabels[i] || '';
        if (hdr.startsWith('namespace')) return; // already built
        if (hdr === 'status') {
          const html = _buildStatusCellContent(resource, namespace, kind, name);
          if (html) { td.innerHTML = html; td.removeAttribute('style'); }
        } else if (hdr === 'labels') {
          td.innerHTML = _buildLabelsCellContent(resource.metadata?.labels);
          td.removeAttribute('style');
        } else if (hdr.includes('selector')) {
          const html = _buildSelectorCellContent(resource, namespace, kind, name);
          if (html) { td.innerHTML = html; td.removeAttribute('style'); }
        }
      });

      // No longer a bare synthetic — upgrader should leave it alone.
      delete tr.dataset.ocPilotSynthetic;
      tr.dataset.ocPilotEnriched = '1';
    }));
  }

  // Remove the pinned-favourites table wrapper if present, then notify
  // ReactVirtualized to recalculate its scroll-position offset.
  function clearPinnedSection() {
    const wrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
    if (wrapper) {
      wrapper.remove();
      _scheduleRvResize();
    }
  }

  function injectPinnedSection() {
    // ── Snapshot rows from the EXISTING pinned section ────────────────────────
    // Capture current pinned rows BEFORE any DOM changes so we have a fallback
    // for favourites whose live row has been virtualised out of the DOM.
    // Concretely: favourite A; scroll past A; favourite B → without this,
    // rebuild would only find B in the live DOM and lose A from the section.
    const cachedClones = new Map(); // "ns|kind|name" → detached <tr>
    const existingWrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
    if (existingWrapper) {
      existingWrapper.querySelectorAll('tr[data-oc-pilot-is-clone="1"]').forEach(tr => {
        const wrap = tr.querySelector('.oc-pilot-star-wrap[data-star-path]');
        if (!wrap) return;
        const pp = parseResourceDetailHref(wrap.dataset.starPath);
        if (!pp) return;
        cachedClones.set(
          pp.namespace + '|' + pp.resourceKind + '|' + pp.resourceName,
          tr.cloneNode(true)
        );
      });
    }

    if (!FEATURES.favourites) return;
    if (!_favsLoaded) return;
    const listInfo = parseResourceListUrl(location.pathname);
    if (!listInfo) return;
    // Only show the pinned section for supported resource kinds.
    if (!FAVOURITE_KINDS.has(listInfo.resourceKind)) return;

    const isAllNs = listInfo.namespace === '__cluster__' &&
      location.pathname.includes('/all-namespaces/');

    // For cluster-scoped (non-all-namespaces) views skip the pinned section.
    if (listInfo.namespace === '__cluster__' && !isAllNs) return;

    // Determine the normalised resource kind (e.g. "deployments"). Sources in
    // priority order:
    //   1. The URL itself — most reliable, matches what star-wraps will use.
    //   2. A live star-wrap — covers GVK redirects like apps~v1~Deployment.
    //   3. A cached clone — handles the case where the wrap injection raced.
    let resourceKind = listInfo.resourceKind || null;
    if (!resourceKind) {
      const firstWrap = document.querySelector('.oc-pilot-star-wrap[data-star-path]');
      if (firstWrap) {
        const fp = parseResourceDetailHref(firstWrap.dataset.starPath);
        if (fp) resourceKind = fp.resourceKind;
      }
    }
    if (!resourceKind && cachedClones.size) {
      const firstKey = cachedClones.keys().next().value;
      if (firstKey) resourceKind = firstKey.split('|')[1];
    }
    if (!resourceKind) return;

    // Build the set of favourite (namespace, name) entries for this view.
    const allFavEntries = [];
    if (isAllNs) {
      const hostFavs = _favs[location.hostname] || {};
      for (const [ns, kinds] of Object.entries(hostFavs)) {
        if (ns === '__cluster__') continue;
        (kinds[resourceKind] || []).forEach(name => {
          allFavEntries.push({ namespace: ns, name });
        });
      }
    } else {
      getFavouritesForKind(listInfo.namespace, resourceKind).forEach(name => {
        allFavEntries.push({ namespace: listInfo.namespace, name });
      });
    }
    _dbg('injectPinnedSection: allFavEntries =', allFavEntries.length,
      '| _favs for host:', JSON.stringify(_favs[location.hostname] || {}));
    if (!allFavEntries.length) {
      _dbg('injectPinnedSection: skip — no favourites for this view/kind');
      // No favourites for this view — remove wrapper if present.
      if (existingWrapper) { existingWrapper.remove(); _scheduleRvResize(); }
      return;
    }

    // Sort pinned entries alphabetically by name, with namespace as tiebreaker.
    // toggleFavourite sorts within a single namespace but does not sort the
    // cross-namespace allFavEntries list used for all-namespaces views.
    // Defensive: coerce to string in case storage ever contains non-string data —
    // a throw here would silently break the entire pinned section rendering.
    allFavEntries.sort((a, b) => {
      const nameCmp = String(a.name || '').localeCompare(String(b.name || ''));
      if (nameCmp !== 0) return nameCmp;
      return String(a.namespace || '').localeCompare(String(b.namespace || ''));
    });

    // Index live rows by namespace|kind|name. Exclude rows inside our pinned
    // wrapper (none should exist at this point, but guard anyway).
    const liveRows = Array.from(
      document.querySelectorAll('tbody tr, [role="rowgroup"] [role="row"]')
    ).filter(r => !r.closest('#oc-pilot-pinned-table-wrapper'));
    _dbg('injectPinnedSection: liveRows found:', liveRows.length,
      '| liveRows with star-wrap:', liveRows.filter(r => r.querySelector('.oc-pilot-star-wrap')).length);
    const liveRowByKey = new Map();
    liveRows.forEach(row => {
      const wrap = row.querySelector('.oc-pilot-star-wrap[data-star-path]');
      if (!wrap) return;
      const pp = parseResourceDetailHref(wrap.dataset.starPath);
      if (pp) liveRowByKey.set(
        pp.namespace + '|' + pp.resourceKind + '|' + pp.resourceName,
        row,
      );
    });

    // For each favourite pick a row source: prefer live DOM (most up-to-date),
    // fall back to snapshotted clone (preserves rows scrolled out of view),
    // finally fall back to a synthetic minimal row.
    const matched = [];
    allFavEntries.forEach(({ namespace, name }) => {
      const key = namespace + '|' + resourceKind + '|' + name;

      const liveRow = liveRowByKey.get(key);
      if (liveRow) {
        matched.push({ row: liveRow, namespace, resourceKind, name, synthetic: false });
      } else if (cachedClones.has(key)) {
        // If the cached clone is itself a synthetic single-cell row (e.g. the
        // upgrade rebuilt but the live row still wasn't in the DOM), treat it
        // as synthetic so buildSyntheticPinnedRow fires again with the
        // data-oc-pilot-synthetic marker intact — otherwise upgradeSyntheticPinnedRows
        // can never find it in subsequent scroll events.
        const cachedRow = cachedClones.get(key);
        const cachedIsSynthetic = !!cachedRow.dataset.ocPilotSynthetic;
        matched.push({ row: cachedIsSynthetic ? null : cachedRow, namespace, resourceKind, name, synthetic: cachedIsSynthetic });
      } else {
        matched.push({ row: null, namespace, resourceKind, name, synthetic: true });
      }
    });
    if (!matched.length) {
      if (existingWrapper) { existingWrapper.remove(); _scheduleRvResize(); }
      return;
    }

    // Find the main grid element. Works for both:
    //   • Standard <table> — cloud / CRC installs
    //   • ARIA div grid ([role="grid"]) — some on-premise console versions that
    //     ship without a real <table> element (stars still inject via gridcell
    //     ARIA roles but the old table-only lookup returned null → early exit).
    let mainTable =
      (liveRows[0] && (
        liveRows[0].closest('table') ||
        liveRows[0].closest('[role="grid"]') ||
        liveRows[0].closest('[role="treegrid"]')
      )) ||
      document.querySelector('.co-virtualized-table table') ||
      document.querySelector('table') ||
      document.querySelector('[role="grid"]') ||
      document.querySelector('[role="treegrid"]');
    _dbg('injectPinnedSection: mainTable =',
      mainTable ? `<${mainTable.tagName.toLowerCase()} role="${mainTable.getAttribute('role') || ''}" class="${(mainTable.className || '').substring(0, 60)}">` : 'null');
    if (!mainTable) { _dbg('injectPinnedSection: ABORT — no table/grid found in DOM'); return; }

    // Walk up to the ReactVirtualized / grid wrapper, then to its parent so we
    // can insert the pinned section BEFORE the virtualizer container.
    const rvWrapper =
      mainTable.closest('.co-virtualized-table') ||
      mainTable.closest('.co-m-table-grid') ||
      mainTable.parentElement;
    const insertParent = rvWrapper ? rvWrapper.parentElement : null;
    _dbg('injectPinnedSection: rvWrapper =',
      rvWrapper ? `<${rvWrapper.tagName.toLowerCase()} class="${(rvWrapper.className || '').substring(0, 60)}">` : 'null',
      '| insertParent =',
      insertParent ? `<${insertParent.tagName.toLowerCase()} class="${(insertParent.className || '').substring(0, 60)}">` : 'null');
    if (!insertParent) { _dbg('injectPinnedSection: ABORT — insertParent is null'); return; }

    // (headerCells no longer used — colgroup removed, see comment below.)

    // ── Shared click handler for any pinned-row star button ───────────────────
    const makeStarHandler = (namespace, rk, name) => async (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Bump BEFORE toggleFavourite so the resulting state tells us add-vs-remove
      // (after the toggle, isFavourite returns the NEW state).
      const wasFav = isFavourite(namespace, rk, name);
      bumpEvent(wasFav ? 'click.favourites.remove' : 'click.favourites.add');
      await toggleFavourite(namespace, rk, name);
      const nowFav = isFavourite(namespace, rk, name);
      // Update every star icon for this resource across both tables.
      document.querySelectorAll('.oc-pilot-star-wrap').forEach(w => {
        const p = w.dataset.starPath;
        if (!p) return;
        const pp = parseResourceDetailHref(p);
        if (pp && pp.resourceName === name && pp.namespace === namespace) {
          updateStarIcon(w, nowFav);
        }
      });
      injectPinnedSection();
    };

    // ── Build a fresh <tbody> with the matched rows ───────────────────────────
    // Only the PF5 tbody class — ReactVirtualized__innerScrollContainer must NOT
    // be copied as it drives the virtualizer's own layout.
    const pinnedTbody = document.createElement('tbody');
    pinnedTbody.className = 'pf-v5-c-table__tbody';

    matched.forEach(({ row, namespace, resourceKind: rk, name, synthetic }) => {
      let clone;

      if (synthetic) {
        // Minimal single-cell row: star · name · namespace.  No broken column
        // alignment; self-upgrades to a rich clone once the live row scrolls in.
        clone = buildSyntheticPinnedRow(
          namespace, rk, name, makeStarHandler(namespace, rk, name)
        );
      } else {
        clone = row.cloneNode(true);

        // Strip ALL ReactVirtualized inline-layout properties so the row flows
        // as a normal table row inside our static table.
        clone.style.removeProperty('position');
        clone.style.removeProperty('top');
        clone.style.removeProperty('left');
        clone.style.removeProperty('transform');
        clone.style.removeProperty('height');
        clone.style.removeProperty('width');

        // Amber left accent to visually distinguish pinned rows.
        clone.style.borderLeft = '3px solid #f59e0b';
        clone.dataset.ocPilotIsClone = '1';
        // Clear synthetic marker if this clone was previously a synthetic row.
        delete clone.dataset.ocPilotSynthetic;

        // Re-wire the star button — cloneNode drops all event listeners.
        const cloneWrap = clone.querySelector('.oc-pilot-star-wrap');
        if (cloneWrap) {
          const freshWrap = cloneWrap.cloneNode(true);
          cloneWrap.parentNode.replaceChild(freshWrap, cloneWrap);
          updateStarIcon(freshWrap, true); // always amber in the pinned section
          freshWrap.addEventListener('click', makeStarHandler(namespace, rk, name));
        }
      }

      pinnedTbody.appendChild(clone);
    });

    // ── Reuse or create the pinned wrapper ────────────────────────────────────
    // Updating in-place (when wrapper already exists in the right parent) avoids
    // a remove→reinsert cycle that would:
    //   • dispatch multiple resize events, confusing ReactVirtualized's
    //     _positionFromTop cache and creating large blank areas as favourites grow,
    //   • replace the row DOM mid-click, making the star appear to need two clicks.
    //
    // We use table-layout:auto (the browser default) instead of fixed+colgroup.
    // The fixed+colgroup approach caused columns to collapse to 0px if
    // mainTable.offsetWidth was 0 at inject time (e.g. before the first paint),
    // making all cell text render vertically. Auto layout distributes space from
    // content, which is always readable even when the table is first inserted.
    if (existingWrapper && existingWrapper.parentElement === insertParent) {
      // UPDATE IN PLACE — only swap tbody; table width is already correct.
      const existingPinnedTable = existingWrapper.querySelector('table');
      if (existingPinnedTable) {
        existingPinnedTable.querySelector('tbody')?.remove();
        existingPinnedTable.appendChild(pinnedTbody);
      }
    } else {
      // FULL BUILD — create wrapper from scratch and insert before the virtualizer.
      if (existingWrapper) existingWrapper.remove();

      const wrapper = document.createElement('div');
      wrapper.id = 'oc-pilot-pinned-table-wrapper';
      wrapper.setAttribute('style', 'margin-bottom:16px;');

      const sectionHeader = document.createElement('div');
      sectionHeader.setAttribute('style', [
        'display:flex',
        'align-items:center',
        'gap:6px',
        'padding:4px 0 6px 2px',
        'font-size:11px',
        'font-weight:600',
        'color:rgba(245,158,11,0.85)',
        'text-transform:uppercase',
        'letter-spacing:0.06em',
        'border-bottom:1px solid rgba(245,158,11,0.35)',
        'margin-bottom:2px',
      ].join(';'));
      sectionHeader.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" style="flex-shrink:0">' +
        '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
        '</svg> Pinned Favourites';
      wrapper.appendChild(sectionHeader);

      const pinnedTable = document.createElement('table');
      // Only copy PatternFly / OpenShift CSS classes — NOT ReactVirtualized or
      // window-scroller classes, which collapse the table to zero-width when
      // outside the virtualizer's own container.
      // Copy PF/OCP classes from the main table (or grid div). For ARIA div grids
      // there may be no matching classes — fall back to standard PF5 ones.
      const pfOnlyClasses = (mainTable.tagName === 'TABLE' ? mainTable.className : '')
        .split(/\s+/)
        .filter(c => c.startsWith('pf-') || c.startsWith('co-'))
        .join(' ');
      pinnedTable.className = pfOnlyClasses || 'pf-v5-c-table pf-m-compact pf-m-border-rows';
      // width:100% fills the container; auto layout sizes columns from content.
      pinnedTable.style.width = '100%';

      // For all-namespaces: synthetic rows only have '—' placeholders in the
      // Status/Labels/Pod-selector columns, so table-layout:auto collapses them
      // and over-expands Name. Read the actual rendered <th> widths from the
      // page's header and apply them via colgroup + table-layout:fixed so that
      // all pinned rows align column-for-column with the main table.
      if (isAllNs) {
        // Support both <thead> (table-based) and the first [role="rowgroup"] (div grids).
        const thead =
          document.querySelector('thead') ||
          document.querySelector('[role="rowgroup"]:not(#oc-pilot-pinned-table-wrapper [role="rowgroup"])');
        if (thead) {
          const thWidths = [...thead.querySelectorAll('th, [role="columnheader"]')]
            .map(th => th.offsetWidth);
          // Only apply fixed layout if the browser has painted the header
          // (offsetWidth > 0 for at least one column).
          if (thWidths.length && thWidths.some(w => w > 0)) {
            const colgroup = document.createElement('colgroup');
            thWidths.forEach(w => {
              const col = document.createElement('col');
              col.style.width = (w > 0 ? w : 80) + 'px';
              colgroup.appendChild(col);
            });
            pinnedTable.appendChild(colgroup);
            pinnedTable.style.tableLayout = 'fixed';
          }
        }
      }

      pinnedTable.appendChild(pinnedTbody);
      wrapper.appendChild(pinnedTable);
      insertParent.insertBefore(wrapper, rvWrapper);
      _dbg('injectPinnedSection: ✓ pinned section inserted with', matched.length, 'row(s)');
    }

    // Apply any active console filter so the pinned table mirrors the main one.
    applyFilterToPinnedSection();

    // Asynchronously fill in Status / Labels / Pod-selector for any synthetic
    // rows that couldn't be cloned from the live DOM (row outside the RV viewport).
    enrichSyntheticPinnedRows().catch(() => {});

    // Notify ReactVirtualized of the layout change (deferred + deduplicated to
    // avoid cascading MutationObserver callbacks on rapid successive rebuilds).
    _scheduleRvResize();
  }

  // ── Filter sync ────────────────────────────────────────────────────────────
  // The OpenShift console's "Filter by name" input filters rows in the main
  // resource table but knows nothing about our injected pinned section. We
  // mirror its current state by:
  //   1. Reading the current filter text from the input or `?name=` URL param
  //   2. Hiding pinned rows whose resource name doesn't contain the filter
  //   3. Hiding the whole pinned wrapper if zero rows match (so an empty
  //      "Pinned Favourites" header doesn't sit above the filtered table)
  // Re-applied on every keystroke via a delegated input listener and on every
  // pinned-section rebuild so newly-favourited rows inherit the active filter.

  function findFilterInput() {
    // OCP/OKD across versions has used several attribute names for the filter
    // input. Try them in priority order; first match wins.
    const selectors = [
      'input[data-test-id="item-filter"]',
      'input[data-test="filter-input"]',
      'input[data-test*="name-filter" i]',
      'input[aria-label*="filter" i]',
      'input[placeholder*="filter by name" i]',
      'input[placeholder^="Filter" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el instanceof HTMLInputElement) return el;
    }
    return null;
  }

  function getCurrentFilterText() {
    const input = findFilterInput();
    if (input) {
      // Use the input's live .value — it's always current when the 'input' event
      // fires, even when the field is cleared.  Do NOT fall through to the URL
      // when the input is empty: the URL still carries the previous ?name= value
      // while React asynchronously updates the route, which would return stale
      // filter text and leave the pinned section filtered after the user clears.
      return input.value || '';
    }
    // No filter input in the DOM — fall back to the URL query param.
    try {
      return new URLSearchParams(location.search).get('name') || '';
    } catch (_) { return ''; }
  }

  function applyFilterToPinnedSection() {
    const wrapper = document.getElementById('oc-pilot-pinned-table-wrapper');
    if (!wrapper) return;

    const text = getCurrentFilterText().trim().toLowerCase();
    let visibleCount = 0;
    wrapper.querySelectorAll('tr[data-oc-pilot-is-clone="1"]').forEach((tr) => {
      const w = tr.querySelector('.oc-pilot-star-wrap[data-star-path]');
      if (!w) return;
      const pp = parseResourceDetailHref(w.dataset.starPath);
      if (!pp) return;
      const matches = !text || pp.resourceName.toLowerCase().includes(text);
      tr.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;
    });

    // Hide the entire wrapper when nothing matches so the section header
    // doesn't appear orphaned above an empty-looking area.
    wrapper.style.display = visibleCount === 0 ? 'none' : '';
  }

  // Install a single delegated listener — survives SPA re-renders that recreate
  // the filter <input> element.  Uses capture so we still see the event even if
  // the page stops it from bubbling.
  if (!window.__ocPilotFilterListener) {
    window.__ocPilotFilterListener = true;
    const handle = (e) => {
      const t = e.target;
      if (!t || !(t instanceof HTMLInputElement)) return;
      const ds = t.dataset || {};
      const isFilter =
        ds.testId === 'item-filter' ||
        ds.test === 'filter-input' ||
        /name-filter/i.test(ds.test || '') ||
        /filter/i.test(t.getAttribute('aria-label') || '') ||
        /^filter/i.test(t.placeholder || '');
      if (!isFilter) return;
      applyFilterToPinnedSection();
    };
    document.addEventListener('input', handle, true);
    // Some flows update the input via change/keyup without firing 'input'.
    document.addEventListener('keyup', handle, true);
    document.addEventListener('change', handle, true);
  }

  function tryInjectDetailStar() {
    if (!FEATURES.favourites) return;
    if (!_favsLoaded) return;
    if (document.querySelector('.oc-pilot-detail-star')) return; // already injected

    const name = parseCurrentResourceName(location.pathname);
    if (!name) return; // not a detail page
    const parsed = parseResourceDetailHref(location.pathname);
    if (!parsed) return;
    // Only show the detail star on supported resource kinds.
    if (!FAVOURITE_KINDS.has(parsed.resourceKind)) return;

    const anchor = findAnchor(name);
    if (!anchor) return; // not rendered yet — observer/poll will retry

    const el = anchor.el;
    // Avoid anchors that are navigable links or breadcrumbs.
    if (el.tagName === 'A' || el.closest('a') || el.closest('nav, [aria-label="Breadcrumb"]')) return;

    const { namespace, resourceKind, resourceName } = parsed;
    const fav = isFavourite(namespace, resourceKind, resourceName);

    const btn = document.createElement('button');
    btn.className = 'oc-pilot-detail-star';
    btn.title = fav ? 'Remove from favourites' : 'Add to favourites';
    btn.setAttribute('style', [
      'background:none',
      'border:none',
      'padding:0 0 0 8px',
      'cursor:pointer',
      'display:inline-flex',
      'align-items:center',
      'align-self:center',      // works inside a flex-row parent
      'vertical-align:middle',  // fallback for non-flex parents
      'opacity:0.75',
      'transition:opacity 0.15s,transform 0.15s',
    ].join(';'));
    const svg = buildStarSvg(fav);
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    btn.appendChild(svg);

    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.15)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '0.75';
      btn.style.transform = '';
    });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const wasFav = isFavourite(namespace, resourceKind, resourceName);
      bumpEvent(wasFav ? 'click.favourites.remove' : 'click.favourites.add');
      await toggleFavourite(namespace, resourceKind, resourceName);
      const nowFav = isFavourite(namespace, resourceKind, resourceName);
      btn.title = nowFav ? 'Remove from favourites' : 'Add to favourites';
      const oldSvg = btn.querySelector('svg');
      const newSvg = buildStarSvg(nowFav);
      newSvg.setAttribute('width', '18');
      newSvg.setAttribute('height', '18');
      if (oldSvg) oldSvg.replaceWith(newSvg);
      showFavToast(resourceName, nowFav);
    });

    el.insertAdjacentElement('afterend', btn);

    // The OKD heading row (.co-m-pane__name.co-resource-item) uses
    // align-items:baseline, which scatters items of different heights onto
    // different vertical positions.  Override to center so the icon, title
    // text, star, and any badges all sit on the same midline.
    if (!document.getElementById('oc-pilot-detail-star-style')) {
      const s = document.createElement('style');
      s.id = 'oc-pilot-detail-star-style';
      s.textContent = '.co-m-pane__name.co-resource-item { align-items: center !important; }';
      (document.head || document.documentElement).appendChild(s);
    }

    _dbg(`✓ detail-star attached for "${resourceName}"`);
  }

  function showFavToast(name, added) {
    const existing = document.getElementById('__oc-fav-toast__');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = '__oc-fav-toast__';
    host.setAttribute('style', [
      'all:initial',
      'position:fixed',
      'bottom:18px',
      'right:18px',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'pointer-events:none',
    ].join(';'));

    const shadow = host.attachShadow({ mode: 'closed' });
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

    shadow.innerHTML = `
      <style>
        .wrap {
          display:flex;align-items:center;gap:10px;
          background:#1a1f2e;border:1px solid rgba(245,158,11,0.35);
          border-radius:10px;padding:10px 16px;
          box-shadow:0 8px 24px rgba(0,0,0,0.4);
          animation:slide-in 0.3s cubic-bezier(0.34,1.56,0.64,1) both;
          min-width:220px;max-width:360px;
        }
        .star { color:#f59e0b;display:flex;align-items:center;flex-shrink:0; }
        .msg  { color:#e5e7eb;font-size:13px; }
        .name { color:#f59e0b;font-weight:600; }
        @keyframes slide-in {
          from { opacity:0;transform:translateX(calc(100% + 18px)); }
          to   { opacity:1;transform:translateX(0); }
        }
      </style>
      <div class="wrap">
        <span class="star">
          <svg width="16" height="16" viewBox="0 0 24 24"
               fill="${added ? '#f59e0b' : 'none'}" stroke="#f59e0b"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </span>
        <span class="msg"><span class="name">${esc(name)}</span> ${added ? 'added to favourites' : 'removed from favourites'}</span>
      </div>
    `;

    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 2500);
  }

  // ── Persistent column sort helpers ───────────────────────────────────────

  /** Load ocPilotSortPrefs from storage into _sortPrefs. */
  function loadSortPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('ocPilotSortPrefs', (data) => {
          _sortPrefs = (data || {}).ocPilotSortPrefs || {};
          _sortPrefsLoaded = true;
          resolve();
        });
      } catch (_) { _sortPrefsLoaded = true; resolve(); }
    });
  }

  /**
   * Extract the visible label from a sort button, stripping SVG icons and PF
   * sort-indicator spans so we get only the column-name text.
   */
  function _stripSortIcons(btn) {
    const c = btn.cloneNode(true);
    c.querySelectorAll(
      'svg, .pf-v5-c-table__sort-indicator, .pf-c-table__sort-indicator'
    ).forEach((el) => el.remove());
    return c.textContent.trim();
  }

  /**
   * Read the current sort state from the main table's aria-sort attributes.
   * Returns { column, direction } or null if nothing is sorted.
   * Excludes the pinned section.
   */
  function _getCurrentSort() {
    const sorted = document.querySelector(
      'th[aria-sort="ascending"]:not(#oc-pilot-pinned-table-wrapper th),' +
      'th[aria-sort="descending"]:not(#oc-pilot-pinned-table-wrapper th),' +
      '[role="columnheader"][aria-sort="ascending"]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"]),' +
      '[role="columnheader"][aria-sort="descending"]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"])'
    );
    if (!sorted) return null;
    const direction = sorted.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc';
    const btn = sorted.querySelector('button');
    if (!btn) return null;
    return { column: _stripSortIcons(btn), direction };
  }

  /**
   * Click column headers as needed to reach the stored sort target.
   * PF tables cycle: unsorted → ascending → descending → (ascending again).
   * We always start from the page-default (Name asc) so one click reaches
   * ascending and two clicks reach descending for any other column.
   */
  async function _applySortPreference(resourceKind) {
    if (_sortRestoreInProgress) return; // another restore is already in-flight
    if (!_sortPrefsLoaded) return;
    const target = (_sortPrefs[location.hostname] || {})[resourceKind];
    if (!target) return;

    const current = _getCurrentSort();
    // Already showing the right sort — nothing to do.
    if (current && current.column === target.column && current.direction === target.direction) return;

    // Find the target column's sort button (exclude pinned section).
    const headers = document.querySelectorAll(
      'th[aria-sort]:not(#oc-pilot-pinned-table-wrapper th),' +
      '[role="columnheader"][aria-sort]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"])'
    );
    let targetBtn = null;
    for (const th of headers) {
      const btn = th.querySelector('button');
      if (btn && _stripSortIcons(btn) === target.column) { targetBtn = btn; break; }
    }
    if (!targetBtn) return; // column not present on this resource kind

    // Guard against re-entrant calls triggered by OKD's replaceState (which
    // fires onNavigate → restarts the poll) while we are mid-click.
    _sortRestoreInProgress = true;
    try {
      // Click once → ascending for any non-current column, or toggle if already on it.
      targetBtn.click();

      // If descending is needed, wait for React to re-render and click once more.
      if (target.direction === 'desc') {
        await new Promise((r) => setTimeout(r, 150));
        const after = _getCurrentSort();
        if (!after || after.column !== target.column || after.direction !== 'desc') {
          targetBtn.click();
        }
      }
    } finally {
      _sortRestoreInProgress = false;
    }
  }

  function stopSortRestorePoll() {
    if (_sortPollTimer) { clearInterval(_sortPollTimer); _sortPollTimer = null; }
  }

  /**
   * Poll every 200 ms (up to 10 ticks = 2 s) for sort-capable column headers
   * to appear, then apply the stored sort preference for this resource kind.
   */
  function startSortRestorePoll() {
    stopSortRestorePoll();
    if (!FEATURES.persistSort) return;
    const listInfo = parseResourceListUrl(location.pathname);
    if (!listInfo) return;

    let ticks = 0;
    _sortPollTimer = setInterval(async () => {
      if (++ticks > 75) { stopSortRestorePoll(); return; }
      // Wait until at least one sort-capable header exists (table is rendered).
      const anyHeader = document.querySelector(
        'th[aria-sort]:not(#oc-pilot-pinned-table-wrapper th),' +
        '[role="columnheader"][aria-sort]:not(#oc-pilot-pinned-table-wrapper [role="columnheader"])'
      );
      if (!anyHeader) return;
      stopSortRestorePoll();
      await _applySortPreference(listInfo.resourceKind);
    }, 200);
  }

  // ── SPA navigation ────────────────────────────────────────────────────────

  function onNavigate() {
    document.getElementById('oc-pilot-owner-btn')?.remove();
    document.getElementById('oc-pilot-loading')?.remove();
    document.getElementById('oc-pilot-force-delete-btn')?.remove();
    clearCrossLinks();
    clearTimeout(_podActionsTimer);
    _podActionsTimer = null;
    clearPodActions();
    lastPodKey = '';
    lastRouteKey = '';
    lastDepKey = '';
    lastForceKey = '';
    inFlight = false;
    routeInFlight = false;
    depInFlight = false;
    stopPoll();
    stopRoutePoll();
    stopDepPoll();
    stopForcePoll();
    stopCopyNamePoll();
    stopSortRestorePoll();
    _sortRestoreInProgress = false;
    clearPinnedSection();
    document.querySelector('.oc-pilot-detail-star')?.remove();
    clearTimeout(_starInjectTimer);
    _starInjectTimer = null;

    const podParsed   = parsePodUrl(location.pathname);
    const routeParsed = parseRouteUrl(location.pathname);
    const depParsed   = parseDeploymentUrl(location.pathname);
    const isPodsList  = isPodsListPath(location.pathname);
    _dbg('navigated to', location.pathname,
      podParsed ? '(pod)' :
      routeParsed ? '(route)' :
      depParsed ? '(' + depParsed.kind.toLowerCase() + ')' :
      isPodsList ? '(pods list)' : '(other)'
    );

    if (podParsed) {
      if (FEATURES.ownerLink)   startPoll();
      if (FEATURES.forceDelete) startForcePoll();
    }
    if (routeParsed && FEATURES.crossLinks) startRoutePoll();
    if (depParsed   && FEATURES.crossLinks) startDepPoll();

    tryInject();
    tryInjectForceDelete();
    tryInjectRouteBackend();
    tryInjectDeploymentRoutes();
    if (isPodsList) schedulePodActionsInject();
    // The header is persistent across SPA navigations — injectCopyLoginButton
    // is idempotent (id-based dedup) so it's safe to call on every navigate.
    injectCopyLoginButton();
    // Click-to-copy: the title element is freshly rendered on every navigation
    // so we always try immediately and start a poll for async renders.
    tryInjectClickToCopy();
    startCopyNamePoll();
    if (FEATURES.favourites) {
      // Run star injection immediately (not debounced) so injectPinnedSection
      // can find live row star-wraps and use full row clones instead of
      // falling back to single-cell synthetic rows.
      injectFavouriteStars();
      injectPinnedSection();
      scheduleStarInject();
      tryInjectDetailStar();
    }
    if (FEATURES.persistSort) startSortRestorePoll();
  }

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn].bind(history);
    history[fn] = function (...args) { orig(...args); onNavigate(); };
  });
  window.addEventListener('popstate', onNavigate);

  // MutationObserver: retries every injector as the console's React tree
  // (and any virtualized list) settles or scrolls. rAF-throttled so a burst
  // of row renders doesn't hammer querySelectorAll.
  let injectScheduled = false;
  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
      injectScheduled = false;
      const onPodPage = !!parsePodUrl(location.pathname);
      if (!inFlight       && !pollTimer      && onPodPage)                             tryInject();
      if (!forcePollTimer && onPodPage && !document.getElementById('oc-pilot-force-delete-btn')) tryInjectForceDelete();
      if (!routeInFlight  && !routePollTimer && parseRouteUrl(location.pathname))      tryInjectRouteBackend();
      if (!depInFlight    && !depPollTimer   && parseDeploymentUrl(location.pathname)) tryInjectDeploymentRoutes();
      if (parseDeploymentUrl(location.pathname)) tryInjectRouteDetails();
      if (isPodsListPath(location.pathname)) schedulePodActionsInject();
      // Retry header-button injection until the header DOM is available.
      injectCopyLoginButton();
      // Retry click-to-copy until the title element is available (React renders async).
      tryInjectClickToCopy();
      // Favourites: retry star injection on list pages, re-pin if displaced.
      if (FEATURES.favourites) {
        if (parseResourceListUrl(location.pathname)) {
          scheduleStarInject();
          if (!document.getElementById('oc-pilot-pinned-table-wrapper')) {
            injectPinnedSection();
          } else {
            // Upgrade synthetic placeholder rows to rich clones when their
            // live row scrolls into the virtualized DOM. Cheap when there
            // are no synthetics (early exit) and self-terminating because
            // each rebuild reduces or eliminates the synthetic set.
            upgradeSyntheticPinnedRows();
          }
        }
        tryInjectDetailStar();
      }
    });
  }
  new MutationObserver(scheduleInject)
    .observe(document.documentElement, { childList: true, subtree: true });

  // ── Init ──────────────────────────────────────────────────────────────────

  _dbg('loaded on', location.pathname);
  // Load feature flags from storage before first injection so we respect any
  // settings the user has saved. The callback re-runs the injectors once the
  // flags are known.
  loadFeatures(() => {
    if (parsePodUrl(location.pathname)) {
      if (FEATURES.ownerLink)   startPoll();
      if (FEATURES.forceDelete) startForcePoll();
    }
    if (parseRouteUrl(location.pathname)      && FEATURES.crossLinks) startRoutePoll();
    if (parseDeploymentUrl(location.pathname) && FEATURES.crossLinks) startDepPoll();
    tryInject();
    tryInjectForceDelete();
    tryInjectRouteBackend();
    tryInjectDeploymentRoutes();
    if (isPodsListPath(location.pathname)) schedulePodActionsInject();
    injectCopyLoginButton();
    tryInjectClickToCopy();
    startCopyNamePoll();
    if (FEATURES.favourites) {
      loadFavourites().then(() => {
        // Run star injection immediately so injectPinnedSection can find
        // live row star-wraps and clone full rows instead of synthetic stubs.
        injectFavouriteStars();
        injectPinnedSection();
        scheduleStarInject();
        tryInjectDetailStar();
      });
    }
    loadClusterColour().then(() => applyToolbarColour());
    loadSortPrefs().then(() => { if (FEATURES.persistSort) startSortRestorePoll(); });
  });

  // ── Sort-save delegated listener ─────────────────────────────────────────
  // Registered once at init time. Captures clicks on sort-header buttons,
  // waits 150 ms for React to re-render, then reads aria-sort and saves the
  // result to ocPilotSortPrefs. Uses capture phase so it fires before any
  // stopPropagation calls from existing handlers.
  document.addEventListener('click', (e) => {
    if (!FEATURES.persistSort) return;
    const listInfo = parseResourceListUrl(location.pathname);
    if (!listInfo) return;
    // Is the click inside a sort-capable column header button?
    const btn = e.target.closest(
      'th[aria-sort] button, [role="columnheader"][aria-sort] button'
    );
    if (!btn) return;
    if (btn.closest('#oc-pilot-pinned-table-wrapper')) return;
    // Debounce: wait for React to apply the new aria-sort value.
    clearTimeout(_sortSaveTimer);
    _sortSaveTimer = setTimeout(() => {
      const current = _getCurrentSort();
      const { resourceKind } = listInfo;
      const hostMap = _sortPrefs[location.hostname] || {};
      if (current) {
        hostMap[resourceKind] = current;
      } else {
        delete hostMap[resourceKind]; // user cycled back to no sort
      }
      _sortPrefs[location.hostname] = hostMap;
      chrome.storage.local.set({ ocPilotSortPrefs: _sortPrefs }, () => {
        if (chrome.runtime.lastError) return;
        _dbg('sort saved:', resourceKind, current);
      });
    }, 150);
  }, true); // capture phase

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ── Self-register this hostname with the background ───────────────────────
  // On-premise OpenShift clusters use custom console routes that don't start
  // with "console-openshift-console". The background can't know about them in
  // advance. By sending this message every time the content script loads (first
  // load is always a /k8s/* direct navigation that matches the manifest pattern),
  // the background adds the hostname to its injection list. Future visits —
  // including loads starting at /overview or / — then get the content script
  // injected before any SPA navigation, keeping pushState patched from the start.
  try {
    chrome.runtime.sendMessage({
      type: "registerConsoleHost",
      hostname: location.hostname,
    });
  } catch (_) {}
})();
