/**
 * OC Pilot — ReactVirtualized scroll-position repair (MAIN world)
 *
 * Runs in the page's MAIN JavaScript world (declared in manifest.json with
 * "world": "MAIN") so it has direct, unfenced access to page-world React
 * component instances. The isolated-world content-console.js cannot modify
 * page-world objects (Object.defineProperty mutations are invisible to the
 * page) and cannot inject inline scripts (CSP blocks 'unsafe-inline').
 * Instead, it dispatches a custom DOM event ('oc-pilot:rv-sync') which this
 * script handles.
 *
 * Responsibilities:
 *   1. patchPositionProp   — intercept _positionFromTop with Object.defineProperty
 *      so every future updatePosition() call automatically resyncs state.scrollTop.
 *   2. When the pinned section has grown or shrunk (pinnedHeight changed):
 *      a. updatePosition()       — re-measure _positionFromTop from the DOM.
 *      b. refreshScrollState()   — call __handleWindowScrollEvent() to resync
 *         state.scrollTop, BUT ONLY when the user is actually scrolled down.
 *
 * WHY the scrollTop guard matters:
 *   __handleWindowScrollEvent() sets ReactVirtualized's isScrolling flag to true,
 *   which applies pointer-events: none to the entire virtualizer grid for ~150 ms
 *   (the debounce period). Calling it when the user is at the top (scrollTop = 0)
 *   is harmless for layout but disables star-button clicks for that window.
 *   When not scrolled, state.scrollTop is already 0 (max(0, 0 - positionFromTop) = 0)
 *   so the call would be a no-op anyway — skip it.
 *
 * WHY pinnedHeight gate matters:
 *   The isolated-world MutationObserver fires on every ReactVirtualized row
 *   re-render during normal scrolling, triggering _scheduleRvResize on each frame.
 *   Without checking whether the pinned section actually changed, updatePosition()
 *   would fire on every scroll frame → corrupting state.scrollTop → blank space.
 */
(function () {
  'use strict';

  // Track the last pinned-section height we acted on. Syncs are no-ops when
  // the height is unchanged (normal scroll re-renders, row highlight updates, etc.)
  var _lastPinnedHeight = -1;

  function findWindowScrollerInstance() {
    var rvEl = document.querySelector(
      '[class*="ReactVirtualized__VirtualGrid"]:not([class*="innerScroll"])'
    );
    if (!rvEl) return null;
    var fk = Object.keys(rvEl).find(function (k) {
      return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
    });
    if (!fk) return null;
    var fiber = rvEl[fk];
    while (fiber) {
      var inst = fiber.stateNode;
      if (inst && typeof inst._positionFromTop !== 'undefined') return inst;
      fiber = fiber.return;
    }
    return null;
  }

  /** Return the scrollElement's current scrollTop, or 0 if not available. */
  function getScrollTop(inst) {
    var scrollEl = inst && inst.props && inst.props.scrollElement;
    if (!scrollEl || scrollEl === window) return window.scrollY || window.pageYOffset || 0;
    return scrollEl.scrollTop || 0;
  }

  /**
   * Call __handleWindowScrollEvent() only when the user is actually scrolled.
   * When scrollTop = 0, state.scrollTop is already 0 and the call would
   * unnecessarily set isScrolling: true → pointer-events: none on the grid.
   */
  function refreshScrollState(inst) {
    if (!inst) return;
    if (getScrollTop(inst) > 0 && typeof inst.__handleWindowScrollEvent === 'function') {
      inst.__handleWindowScrollEvent();
    }
  }

  function patchPositionProp(inst) {
    if (!inst || inst._ocPilotPosPropPatched) return;
    var _pos = inst._positionFromTop;
    Object.defineProperty(inst, '_positionFromTop', {
      get: function () { return _pos; },
      set: function (v) {
        _pos = v;
        var self = this;
        // Defer so React's setState fires outside the synchronous update cycle.
        // Guard: only resync if the user is actually scrolled — calling
        // __handleWindowScrollEvent at scrollTop = 0 sets isScrolling: true
        // unnecessarily, which disables pointer-events on the grid for ~150 ms.
        setTimeout(function () {
          if (getScrollTop(self) > 0 &&
              typeof self.__handleWindowScrollEvent === 'function') {
            self.__handleWindowScrollEvent();
          }
        }, 0);
      },
      configurable: true,
      enumerable: true,
    });
    inst._ocPilotPosPropPatched = true;
  }

  // Listen for sync requests from the isolated-world content script.
  // The DOM is shared between worlds, so CustomEvents dispatched by the
  // isolated world are visible to listeners registered here.
  document.addEventListener('oc-pilot:rv-sync', function (e) {
    try {
      var inst = findWindowScrollerInstance();

      // Always install the _positionFromTop interceptor (idempotent after first call).
      patchPositionProp(inst);

      // Only re-measure and resync when the pinned section has actually grown or
      // shrunk. During normal scrolling the virtualizer re-renders rows which
      // fires MutationObserver → _scheduleRvResize → this event — but pinnedHeight
      // stays the same. Calling updatePosition() on those frames corrupts
      // state.scrollTop and produces the phantom blank space.
      var pinnedHeight = (e.detail && typeof e.detail.pinnedHeight === 'number')
        ? e.detail.pinnedHeight
        : -1;

      if (pinnedHeight === _lastPinnedHeight) return;
      _lastPinnedHeight = pinnedHeight;

      // Pinned section grew or shrank — force a fresh measurement of
      // _positionFromTop. ReactVirtualized only calls updatePosition() on
      // window/scrollElement resize; it never fires when our section grows.
      if (inst && typeof inst.updatePosition === 'function') {
        inst.updatePosition();
      }
      // Belt-and-suspenders: also call __handleWindowScrollEvent() directly,
      // in case updatePosition() found _positionFromTop unchanged (no-op path).
      // Skipped when not scrolled — would set isScrolling: true for no gain.
      refreshScrollState(inst);
    } catch (_) {}
  });
})();
