import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasStats, Square } from './types';
import {
  type LibraryCluster,
  makeCluster,
  loadLibrary,
  saveLibrary,
} from './library';
import constraintsFile from './constraints_file.txt?raw';
import { type Constraints, EMPTY_CONSTRAINTS } from '../backend/types';
import { parseConstraints } from '../backend/parseConstraints';
import { parsePrompt } from '../backend/parsePrompt';
import { resolveRoomList } from './rooms/roomCatalog';
import { isFindQuery } from './search/findQuery';
import type { FixResult } from './constraints/autofix';
import {
  InfiniteCanvas,
  type CanvasHandle,
  type SelectedPanelInfo,
} from './components/InfiniteCanvas/InfiniteCanvas';
import { ActionButton } from './components/ActionButton/ActionButton';
import { NavBar } from './components/NavBar/NavBar';
import { DebugToggle } from './components/DebugToggle/DebugToggle';
import { StatsBar } from './components/StatsBar/StatsBar';
import { FpsMeter } from './components/FpsMeter/FpsMeter';
import { AdjacencyMatrix } from './components/AdjacencyMatrix/AdjacencyMatrix';
import { TopBar, type Mode } from './components/TopBar/TopBar';
import { TopRightBar } from './components/TopRightBar/TopRightBar';
import { RenderPanel, type RenderState } from './components/RenderPanel/RenderPanel';
import { AssemblyInspector } from './components/AssemblyInspector/AssemblyInspector';
import { FacadePanel } from './components/FacadePanel/FacadePanel';
import { CellSplitMenu } from './components/CellSplitMenu/CellSplitMenu';
import {
  newDoc,
  summarizeDoc,
  type CellRef,
  type FacadeSummary,
  type OptimizeStrategy,
  type Rect,
} from './facade/partition';
import { renderFacadeSelection } from './facade/render';
import type { AssemblyMetadata } from './facade/metadata';
import {
  seedAssemblyMetadata,
  metadataForAssembly,
  fieldGroupsFor,
  facadeType,
  bandInchesFor,
  withBandInches,
} from './facade/catalog';
import type { PanelType } from './facade/standardize';
import { LoginModal } from './components/LoginModal/LoginModal';
import { useAuth } from './auth/useAuth';
import { firebaseEnabled } from './auth/firebase';
import { signOutUser } from './auth/auth';
import { loadUserData, saveUserConstraints, saveUserAdjacency } from './auth/userData';
import { applyAdjacency, DEFAULT_ADJACENCY } from './rooms/roomAdjacency';
import { useWindowSize } from './hooks/useWindowSize';
import { DEFAULT_GRID_SIZE } from './constants';

export default function App() {
  // Imperative bridge: the button drives square placement on the canvas without
  // either component re-rendering during interaction.
  const canvasHandle = useRef<CanvasHandle>(null);

  const { width } = useWindowSize();

  // Central nav pill's screen edges — lets the StatsBar centre each stat pair in
  // the open space beside the menu (rather than jammed to the screen edges).
  const [navBounds, setNavBounds] = useState<{ left: number; right: number } | null>(null);

  // Constraints: the textbox content (seeded from constraints_file.txt) and the
  // structured rules parsed from it. Parsing is debounced and runs off the main
  // thread of typing, so the LLM is hit at most once after the user pauses.
  const [constraintsText, setConstraintsText] = useState(constraintsFile);
  const [constraints, setConstraints] = useState<Constraints>(EMPTY_CONSTRAINTS);

  // Debug overlays (green centre numbers + cyan overlap) — off until toggled.
  const [debug, setDebug] = useState(false);
  // Dev-only Adjacency Matrix window (prediction-rank editor) — opened from the dev cluster.
  const [matrixOpen, setMatrixOpen] = useState(false);
  // Catalog key of the room the cursor is over, used to highlight its row/column in the
  // matrix. Only tracked while the matrix is open (gated below) to avoid re-renders otherwise.
  const [hoverRoomKey, setHoverRoomKey] = useState<string | null>(null);
  const matrixHoverGate = useRef(false);
  useEffect(() => {
    matrixHoverGate.current = debug && matrixOpen;
    if (!matrixHoverGate.current) setHoverRoomKey(null);
  }, [debug, matrixOpen]);
  const handleHoverRoomKey = useCallback((key: string | null) => {
    if (!matrixHoverGate.current) return;
    setHoverRoomKey((prev) => (prev === key ? prev : key));
  }, []);

  // Auth: the Firebase session (null = signed out) and whether the first auth state has
  // arrived. `guest` is a session-only "skip sign-in" flag set from the login modal.
  const { user, authResolved } = useAuth();
  const [guest, setGuest] = useState(false);

  // Export the current plan. Placeholder for now — the actual export (image/PDF/JSON)
  // will be wired here.
  const handleExport = useCallback(() => {
    // TODO: implement plan export.
  }, []);

  // Saved Library clusters (persisted to localStorage). The Library button's screen
  // rect is the canvas's save drop-target; `libraryDragOver` highlights it mid-drag.
  const [library, setLibrary] = useState<LibraryCluster[]>(() => loadLibrary());
  const [libraryDragOver, setLibraryDragOver] = useState(false);
  const libraryButtonRectRef = useRef<DOMRect | null>(null);
  // Rect of the open Library popup (null when closed) — a second save drop-target.
  const libraryPopupRectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    saveLibrary(library);
  }, [library]);

  // A selection dropped onto the Library button → store it as a new cluster (newest
  // first). Memoised so the canvas interaction effect doesn't re-subscribe needlessly.
  const addClusterToLibrary = useCallback((shapes: Square[]) => {
    if (shapes.length === 0) return;
    setLibrary((prev) => [makeCluster(shapes), ...prev]);
  }, []);

  const deleteCluster = useCallback((id: string) => {
    setLibrary((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Rename a cluster; an empty title clears it back to the live "N spaces" count.
  const renameCluster = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setLibrary((prev) =>
      prev.map((c) => (c.id === id ? { ...c, name: trimmed || undefined } : c)),
    );
  }, []);

  // Apply a drag-reordered saved-cluster order (persisted by the saveLibrary effect).
  const reorderClusters = useCallback((orderedIds: string[]) => {
    setLibrary((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is LibraryCluster => c != null);
      // Safety: keep any cluster not present in the incoming order (shouldn't happen).
      for (const c of prev) if (!orderedIds.includes(c.id)) next.push(c);
      return next;
    });
  }, []);

  const handleLibraryBounds = useCallback((rect: DOMRect) => {
    libraryButtonRectRef.current = rect;
  }, []);

  // Track the open Library popup's rect (null when closed) so dropping a selection onto the
  // popup itself also saves it — not just the Library button.
  const handleLibraryPopupBounds = useCallback((rect: DOMRect | null) => {
    libraryPopupRectRef.current = rect;
  }, []);

  // True while the Prompt box's LLM request is in flight (shows "Generating…").
  const [promptBusy, setPromptBusy] = useState(false);

  // Smart-find: match count from the last search (null = no active highlight). Drives
  // the "N matches · Esc to clear" chip; the canvas reports null when an edit clears it.
  const [findCount, setFindCount] = useState<number | null>(null);

  const clearFind = useCallback(() => {
    canvasHandle.current?.clearFind();
    setFindCount(null);
  }, []);

  // Whether the yellow constraint-violation highlights are shown on the canvas. The
  // Constraints "Visibility" eye toggles this; the violation count/superscript is
  // independent, so it keeps showing even when the highlights are hidden.
  const [constraintHighlightsOn, setConstraintHighlightsOn] = useState(true);

  // Editor mode shown in the TopBar ("Mode: Plan" ⇄ "Mode: Facade"). Lifted here so the
  // bottom cube (ActionButton) can switch to its Facade look when Facade is active.
  const [editorMode, setEditorMode] = useState<Mode>('Plan');

  // Analyze view (nav toggle): in Plan mode it ghosts every shape on the canvas (same look as Dev
  // mode); in Facade mode the Analyze button instead opens the standardization popup (no ghosting).
  const [analyze, setAnalyze] = useState(false);
  // Facade standardization: whether the Analyze popup is open (turns on the canvas's panel-type
  // colouring + type-group click-select), and the live list of standardized panel types it reports.
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [panelTypes, setPanelTypes] = useState<PanelType[]>([]);

  // Facade-mode AI render: the idle/in-flight/finished render, plus the live selected-shape count
  // (gates the panel's Render button). Triggered by the NavBar Render button.
  const [render, setRender] = useState<RenderState | null>(null);
  const [selectionCount, setSelectionCount] = useState(0);

  // Facade "smart panel" assembly metadata, keyed by assembly type (e.g. "UCWP"). Shared by every
  // panel of a type — editing it in the inspector updates them all and feeds the render prompt.
  // `selectedPanel` is the single selected panel's live geometry + type (null otherwise), reported by
  // the canvas; it drives the inspector and the bidirectional size/band sync.
  const [assemblyMeta, setAssemblyMeta] = useState<Record<string, AssemblyMetadata>>(
    () => seedAssemblyMetadata(),
  );
  const [selectedPanel, setSelectedPanel] = useState<SelectedPanelInfo | null>(null);

  // Facade Layers tool (uniform sticky-cell partition): whether it's active, the live layer/cell summary
  // reported by the canvas (drives the top-center navigator), and the right-click cell-split popover.
  const [layersActive, setLayersActive] = useState(false);
  // Layers tool sub-mode: Border (edit the trim boundary) vs Panels (border locked, edit the inner grid).
  // The tool launches in Border mode so the user draws/shapes the boundary first.
  const [borderMode, setBorderMode] = useState(true);
  // Material-ID (segmentation) view toggle for the Layers tool.
  const [idView, setIdView] = useState(false);
  // Purely-visual drop shadow under the per-group frame bands (depth only). Off by default.
  const [frameShadow, setFrameShadow] = useState(false);
  // Optimize (panel rationalization) popup: open state, the selected strategy, and the live panel metric
  // (total visible panels + how many are unique shapes) queried from the canvas when the popup is open.
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizeStrategy, setOptimizeStrategy] = useState<OptimizeStrategy>('edge-normalize');
  const [panelStats, setPanelStats] = useState<{ total: number; unique: number }>({ total: 0, unique: 0 });
  // Edit-a-panel session: true while zoomed into a selected group editing its per-edge frame.
  const [editingFrame, setEditingFrame] = useState(false);
  const [facadeNav, setFacadeNav] = useState<FacadeSummary>(() => summarizeDoc(newDoc()));
  const [splitMenu, setSplitMenu] = useState<{
    x: number;
    y: number;
    ref: CellRef;
    rect: Rect | null;
  } | null>(null);
  // Live faint preview of the pending split (cell ref + counts), shown on the canvas before Apply. The canvas
  // renders it from the actual resulting partition so it spans the whole boundary and clips like real panels.
  const [splitPreview, setSplitPreview] = useState<{ ref: CellRef; cols: number; rows: number } | null>(
    null,
  );

  // Stable so the canvas's pointer-listener effect doesn't re-subscribe on every App render.
  const handleCellContextMenu = useCallback(
    (info: { screenX: number; screenY: number; ref: CellRef; rect: Rect | null }) =>
      setSplitMenu({ x: info.screenX, y: info.screenY, ref: info.ref, rect: info.rect }),
    [],
  );

  // Close the split menu and drop its preview together.
  const closeSplitMenu = useCallback(() => {
    setSplitMenu(null);
    setSplitPreview(null);
  }, []);

  // Pull the live panel metric (total + unique-shape count) from the canvas.
  const refreshPanelStats = useCallback(() => {
    setPanelStats(canvasHandle.current?.partitionPanelStats() ?? { total: 0, unique: 0 });
  }, []);

  // Open/close the Optimize popup; refresh the panel metric on open so it's current.
  const toggleOptimize = useCallback(() => {
    setOptimizeOpen((open) => {
      if (!open) refreshPanelStats();
      return !open;
    });
  }, [refreshPanelStats]);

  // Apply the selected rationalization strategy (undoable) and re-read the metric to reflect the result.
  const applyOptimize = useCallback(() => {
    canvasHandle.current?.optimizePartition(optimizeStrategy);
    refreshPanelStats();
  }, [optimizeStrategy, refreshPanelStats]);

  // Edit-a-panel: start the session from the right-click menu's Edit (zoom + auto-frame the selected group).
  const startFrameEdit = useCallback(() => {
    // Zoom to the panel that was right-clicked to open this menu, not the group's top-left cell.
    const res = canvasHandle.current?.startPanelFrameEdit(splitMenu?.rect ?? null);
    if (res) setEditingFrame(true);
    closeSplitMenu();
  }, [splitMenu, closeSplitMenu]);

  // Edit-a-panel: end the session (eases the camera back); the per-group frame persists.
  const endFrameEdit = useCallback(() => {
    canvasHandle.current?.endPanelFrameEdit();
    setEditingFrame(false);
  }, []);

  // The Layers tool is Facade-only; turn it off whenever we leave Facade mode.
  useEffect(() => {
    if (editorMode !== 'Facade') setLayersActive(false);
  }, [editorMode]);

  // Close the Optimize popup whenever the Layers tool is off (also covers leaving Facade mode).
  useEffect(() => {
    if (!layersActive) setOptimizeOpen(false);
  }, [layersActive]);

  // End an Edit-a-panel session when the Layers tool turns off, and let Esc finish it too.
  useEffect(() => {
    if (!layersActive && editingFrame) endFrameEdit();
  }, [layersActive, editingFrame, endFrameEdit]);
  useEffect(() => {
    if (!editingFrame) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endFrameEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingFrame, endFrameEdit]);

  // Keep the metric live while the popup is open — facadeNav changes when the partition does (cell splits,
  // border edits), so re-read the unique-shape count on each of those updates.
  useEffect(() => {
    if (optimizeOpen) refreshPanelStats();
  }, [optimizeOpen, facadeNav, refreshPanelStats]);

  // Edit a type-level (non-band) metadata field — applies to the whole assembly type.
  const handleAssemblyFieldChange = useCallback(
    (assembly: string, key: keyof AssemblyMetadata, value: string | number) => {
      setAssemblyMeta((prev) => ({
        ...prev,
        [assembly]: { ...metadataForAssembly(prev, assembly), [key]: value },
      }));
    },
    [],
  );

  // Pick a different facade type for the selected panel (canvas sets name + band, keeps size).
  const handleChangeType = useCallback((key: string) => {
    canvasHandle.current?.setSelectionAssembly(key);
  }, []);

  // Resize the selected panel (per-panel). Edit the band width (type-level) → canvas is the source of
  // truth; it pushes the new band to every panel of the type and reports it back to sync the metadata.
  const handleChangeSize = useCallback((id: string, widthFt: number, heightFt: number) => {
    canvasHandle.current?.setShapeSize(id, widthFt, heightFt);
  }, []);
  const handleChangeBand = useCallback((assembly: string, inches: number) => {
    canvasHandle.current?.applyAssemblyBand(assembly, inches);
  }, []);

  // Bidirectional band sync (single source of truth = the canvas). Whenever the selected panel's live
  // band differs from the type metadata — from a canvas wall drag OR an inspector band edit — write it
  // into the metadata and propagate it to every sibling panel of that type.
  useEffect(() => {
    if (!selectedPanel) return;
    const type = selectedPanel.assembly;
    const metaBand = bandInchesFor(metadataForAssembly(assemblyMeta, type), type);
    if (Math.abs(metaBand - selectedPanel.bandIn) > 1e-3) {
      setAssemblyMeta((prev) => ({
        ...prev,
        [type]: withBandInches(metadataForAssembly(prev, type), type, selectedPanel.bandIn),
      }));
      canvasHandle.current?.applyAssemblyBand(type, selectedPanel.bandIn);
    }
  }, [selectedPanel, assemblyMeta]);

  // Single-pass render: one reference image of the selection + one category-aware prompt → one call.
  const runRender = useCallback(
    async (shapes: Square[], count: number) => {
      setRender({ status: 'loading', count });
      try {
        const { image, prompt } = await renderFacadeSelection({ shapes, metaByAssembly: assemblyMeta });
        setRender({ status: 'done', image, count, prompt });
      } catch (err) {
        setRender({
          status: 'error',
          error: err instanceof Error ? err.message : 'Render failed.',
          count,
        });
      }
    },
    [assemblyMeta],
  );

  // Render the current selection. With nothing selected the panel still opens in an idle state
  // ("Select geometry to render.") and its Render button stays disabled until geometry is selected.
  const handleRender = useCallback(() => {
    const sel = canvasHandle.current?.captureSelectionShapes();
    if (sel) void runRender(sel.shapes, sel.count);
    else setRender({ status: 'idle', count: 0 });
  }, [runRender]);

  // A nav popup (Constraints/Generate/Library) just opened → close the Render popup so only one
  // top-right popup is shown at a time.
  const handlePanelOpenChange = useCallback((open: boolean) => {
    if (open) setRender(null);
  }, []);

  // Guided constraint-fix flow: the current review step, or null when no session is
  // running. The canvas owns the session; this drives the Skip/Approve pill in the nav.
  const [fixStep, setFixStep] = useState<FixResult | null>(null);

  // Store a fresh step, or end the session (restoring the camera) once nothing's left.
  const settleFix = useCallback((r: FixResult | undefined) => {
    if (!r || r.done) {
      canvasHandle.current?.fixCancel();
      setFixStep(null);
    } else {
      setFixStep(r);
    }
  }, []);
  const startFix = useCallback(() => {
    setConstraintHighlightsOn(true); // make the violation visible under the ghost
    settleFix(canvasHandle.current?.fixStart());
  }, [settleFix]);
  const fixApprove = useCallback(
    () => settleFix(canvasHandle.current?.fixApprove()),
    [settleFix],
  );
  const fixSkip = useCallback(() => settleFix(canvasHandle.current?.fixSkip()), [settleFix]);
  const fixActive = fixStep != null && !fixStep.done;
  const fixCanApprove = fixStep != null && !fixStep.done && fixStep.canAutoFix;

  // True while a Save'd constraints text is being (re-)parsed and applied — the
  // Constraints box shows "Saving…" and stays open until this clears.
  const [constraintsBusy, setConstraintsBusy] = useState(false);

  // Save handler: adopt the new text, then parse + apply it. The Constraints box
  // watches `constraintsBusy` and closes itself the moment the rules are applied,
  // so "Saving…" reflects the real round-trip (LLM, or the local fallback).
  // Set + parse + apply the constraints text (no account write — used by load/reset too).
  const applyConstraintsText = useCallback(async (text: string) => {
    setConstraintsText(text);
    setConstraintsBusy(true);
    try {
      setConstraints(await parseConstraints(text));
    } finally {
      setConstraintsBusy(false);
    }
  }, []);

  // A user-initiated Save (from the Constraints editor / Reset defaults): apply, then —
  // when signed in — persist the text to the user's account.
  const handleConstraintsSave = async (text: string) => {
    await applyConstraintsText(text);
    if (user) void saveUserConstraints(user.uid, text);
  };

  // Persist adjacency-matrix edits to the signed-in user's account (called by the dev
  // AdjacencyMatrix after Apply/Reset). No-op for guests / when Firebase is off.
  const handleAdjacencyPersist = useCallback(
    (next: Record<string, Record<string, number>>) => {
      if (user) void saveUserAdjacency(user.uid, next);
    },
    [user],
  );

  // Handle a Prompt-box submission. A search-style prompt ("show me all kitchens")
  // runs an instant local find + highlight; anything else is parsed by the LLM and
  // built as new rooms (e.g. "5 15'x15' rooms").
  const handlePromptSubmit = async (text: string) => {
    if (isFindQuery(text)) {
      const n = canvasHandle.current?.runFind(text) ?? 0;
      setFindCount(n); // no LLM, no busy state — find is synchronous and local
      return;
    }
    setPromptBusy(true);
    try {
      const spec = await parsePrompt(text);
      // The catalog resolver is the visible name→size translation step.
      const placed = resolveRoomList(spec.rooms);
      if (placed.length > 0) {
        canvasHandle.current?.createRoomsFromList(placed);
      }
    } finally {
      setPromptBusy(false);
    }
  };

  // Live canvas stats — drives the bottom StatsBar (fades in at roomCount ≥ 1).
  const [stats, setStats] = useState<CanvasStats>({
    roomCount: 0,
    constraintFlags: 0,
    totalAreaSqft: 0,
    grossAreaSqft: 0,
    usableAreaSqft: 0,
    totalAreaExceeded: false,
    grossAreaExceeded: false,
    roomCountExceeded: false,
    violatedKeys: [],
  });

  useEffect(() => {
    // Parse the seeded constraints once on mount (the regex fallback in
    // parseConstraints covers the no-API-key case). Every later change comes
    // through Save → handleConstraintsSave, which parses and applies explicitly.
    let cancelled = false;
    parseConstraints(constraintsText).then((next) => {
      if (!cancelled) setConstraints(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync app state with the auth session: on a fresh sign-in, load the account's saved
  // constraints + adjacency and apply them; on sign-out, restore the built-in defaults so
  // one account's data never leaks into the next session. Tracks the previous uid so the
  // initial signed-out state (guest / pre-auth) doesn't trigger a spurious reset.
  const prevUidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authResolved) return;
    const uid = user?.uid ?? null;
    if (uid && uid !== prevUidRef.current) {
      prevUidRef.current = uid;
      void loadUserData(uid).then((data) => {
        if (!data) return;
        if (typeof data.constraintsText === 'string') void applyConstraintsText(data.constraintsText);
        if (data.adjacency) applyAdjacency(data.adjacency);
      });
    } else if (!uid && prevUidRef.current) {
      prevUidRef.current = null;
      void applyConstraintsText(constraintsFile);
      applyAdjacency(JSON.parse(JSON.stringify(DEFAULT_ADJACENCY)));
    }
  }, [user, authResolved, applyConstraintsText]);

  // Esc clears an active smart-find highlight (and its chip).
  useEffect(() => {
    if (findCount === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findCount, clearFind]);

  // Esc ends an active constraint-fix session (restoring the camera).
  useEffect(() => {
    if (!fixActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        canvasHandle.current?.fixCancel();
        setFixStep(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fixActive]);

  return (
    <>
      <InfiniteCanvas
        ref={canvasHandle}
        gridSize={DEFAULT_GRID_SIZE}
        constraints={constraints}
        debug={debug}
        // Analyze ghosts the canvas in Plan mode only; in Facade it opens an empty popup
        // (handled in the NavBar) instead of ghosting.
        analyze={analyze && editorMode === 'Plan'}
        facade={editorMode === 'Facade'}
        showConstraintHighlights={constraintHighlightsOn}
        onStatsChange={setStats}
        onSelectionChange={setSelectionCount}
        onSelectedPanelChange={setSelectedPanel}
        layersActive={layersActive && editorMode === 'Facade'}
        borderMode={borderMode}
        idView={idView}
        frameShadow={frameShadow}
        panelNumbers={optimizeOpen || idView}
        splitPreview={splitPreview}
        onPartitionChange={setFacadeNav}
        onCellContextMenu={handleCellContextMenu}
        onExitFrameEdit={endFrameEdit}
        standardize={analyzeOpen && editorMode === 'Facade'}
        onPanelTypesChange={setPanelTypes}
        libraryDropRef={libraryButtonRectRef}
        libraryPopupDropRef={libraryPopupRectRef}
        onLibraryHover={setLibraryDragOver}
        onLibraryDrop={addClusterToLibrary}
        onFindChange={setFindCount}
        onHoverRoomKey={handleHoverRoomKey}
      />
      <TopBar mode={editorMode} onModeChange={setEditorMode} />
      {/* Facade Layers tool: right-docked control panel (Border / Panels, Material-ID, Optimize settings). */}
      {editorMode === 'Facade' && layersActive && (
        <FacadePanel
          layerCount={facadeNav.layerCount}
          activeIndex={facadeNav.activeIndex}
          drawing={facadeNav.drawing}
          borderMode={borderMode}
          idView={idView}
          frameShadow={frameShadow}
          optimizeActive={optimizeOpen}
          total={panelStats.total}
          unique={panelStats.unique}
          strategy={optimizeStrategy}
          borderSelCount={facadeNav.borderSelCount}
          borderSelCanBoolean={facadeNav.borderSelCanBoolean}
          onSelectBorder={() => setBorderMode(true)}
          onSelectLayer={(i) => {
            setBorderMode(false); // switching to a Panels tab locks the border
            canvasHandle.current?.selectLayer(i);
          }}
          onToggleIdView={() => setIdView((v) => !v)}
          onToggleFrameShadow={() => setFrameShadow((v) => !v)}
          onToggleOptimize={toggleOptimize}
          onSelectStrategy={setOptimizeStrategy}
          onApply={applyOptimize}
        />
      )}
      {/* Facade Layers tool: right-click cell-split popover. */}
      {editorMode === 'Facade' && layersActive && splitMenu && (
        <CellSplitMenu
          x={splitMenu.x}
          y={splitMenu.y}
          onChange={(cols, rows) =>
            setSplitPreview(splitMenu.rect ? { ref: splitMenu.ref, cols, rows } : null)
          }
          onApply={(cols, rows) => {
            canvasHandle.current?.splitCell(splitMenu.ref, cols, rows);
            closeSplitMenu();
          }}
          onClose={closeSplitMenu}
          onEdit={startFrameEdit}
          onAssignKind={(kind) => {
            canvasHandle.current?.assignPanelKind(kind);
            closeSplitMenu();
          }}
        />
      )}
      {/* Global budget breach (Max Total Area, Max Total Gross Area, or Max Room
          Count): wash the canvas the constraint yellow until enough rooms are deleted
          to get back under budget. Sits at z-index 1 — between the grid (0) and the
          scene/shape layer (2) — so it reads as a background BEHIND the rooms, leaving
          per-room flags (edges, infills) visible on top. Non-interactive so it never
          blocks canvas gestures. */}
      {constraintHighlightsOn &&
        (stats.totalAreaExceeded || stats.grossAreaExceeded || stats.roomCountExceeded) && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            background: 'rgba(250, 204, 21, 0.22)',
          }}
        />
      )}
      <NavBar
        constraintsText={constraintsText}
        onConstraintsTextChange={handleConstraintsSave}
        defaultConstraintsText={constraintsFile}
        constraintsBusy={constraintsBusy}
        violatedConstraintKeys={stats.violatedKeys}
        constraintHighlightsVisible={constraintHighlightsOn}
        onToggleConstraintHighlights={() => setConstraintHighlightsOn((v) => !v)}
        analyzeActive={analyze}
        onToggleAnalyze={() => setAnalyze((v) => !v)}
        onAnalyzeOpenChange={setAnalyzeOpen}
        panelTypes={panelTypes}
        onSelectPanelType={(ids) => canvasHandle.current?.selectShapeIds(ids)}
        facadeActive={editorMode === 'Facade'}
        onRender={handleRender}
        onPanelOpenChange={handlePanelOpenChange}
        onFix={startFix}
        findMatchCount={findCount}
        onBoundsChange={setNavBounds}
        onPromptSubmit={handlePromptSubmit}
        promptBusy={promptBusy}
        canvasRef={canvasHandle}
        library={library}
        constraintFlagCount={stats.constraintFlags}
        onDeleteCluster={deleteCluster}
        onRenameCluster={renameCluster}
        onReorderClusters={reorderClusters}
        onLibraryBoundsChange={handleLibraryBounds}
        onLibraryPopupBoundsChange={handleLibraryPopupBounds}
        libraryDragActive={libraryDragOver}
        fixActive={fixActive}
        fixCanApprove={fixCanApprove}
        onFixApprove={fixApprove}
        onFixSkip={fixSkip}
      >
        <ActionButton
          canvasRef={canvasHandle}
          facade={editorMode === 'Facade'}
          onArmFacadeBorder={() => {
            setLayersActive(true);
            setBorderMode(true); // arm border placement in the trim-editing sub-mode
          }}
        />
      </NavBar>
      <StatsBar
        visible={stats.roomCount > 0}
        roomCount={stats.roomCount}
        roomCountExceeded={stats.roomCountExceeded}
        totalAreaSqft={stats.totalAreaSqft}
        totalAreaExceeded={stats.totalAreaExceeded}
        grossAreaSqft={stats.grossAreaSqft}
        grossAreaExceeded={stats.grossAreaExceeded}
        usableAreaSqft={stats.usableAreaSqft}
        navBounds={navBounds}
        viewportWidth={width}
        rightAddon={
          debug ? (
            <>
              <button
                type="button"
                onClick={() => setMatrixOpen((o) => !o)}
                title="Open the prediction adjacency matrix"
                style={{
                  border: 'none',
                  borderRadius: 8,
                  padding: '5px 10px',
                  font: 'inherit',
                  // Match the FPS·ms readout's type (12px / 500 / #a1a1aa).
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  color: matrixOpen ? '#ffffff' : '#a1a1aa',
                  background: matrixOpen ? '#6ea8fe' : 'rgba(15, 23, 42, 0.06)',
                }}
              >
                Matrix
              </button>
              <FpsMeter />
            </>
          ) : undefined
        }
      >
        <DebugToggle on={debug} onChange={setDebug} />
      </StatsBar>
      {debug && matrixOpen && (
        <AdjacencyMatrix
          key={user?.uid ?? 'guest'}
          onClose={() => setMatrixOpen(false)}
          onPersist={handleAdjacencyPersist}
          hoveredKey={hoverRoomKey}
        />
      )}
      {/* Top-right action cluster (Export + sign-out). Always on screen — including over the
          login modal — so it doesn't pop in after sign-in / continue-as-guest. Sign-out signs a
          real user out or ends a guest session (a harmless no-op on the login screen itself). */}
      <TopRightBar
        onExport={handleExport}
        email={user?.email}
        onSignOut={() => {
          void signOutUser();
          setGuest(false);
        }}
      />
      {/* Facade mode: left "smart panel" inspector for the single selected panel. The title picks the
          facade type; size + band edits flow to the canvas (and back); other fields edit the
          type-level metadata (every panel of it) and feed the render prompt. */}
      {editorMode === 'Facade' && selectedPanel && (
        <AssemblyInspector
          assembly={selectedPanel.assembly}
          meta={metadataForAssembly(assemblyMeta, selectedPanel.assembly)}
          fieldGroups={fieldGroupsFor(selectedPanel.assembly)}
          bandField={facadeType(selectedPanel.assembly).bandField}
          widthFt={selectedPanel.widthFt}
          heightFt={selectedPanel.heightFt}
          onChangeType={handleChangeType}
          onChange={(key, value) => handleAssemblyFieldChange(selectedPanel.assembly, key, value)}
          onChangeBand={(inches) => handleChangeBand(selectedPanel.assembly, inches)}
          onChangeSize={(w, h) => handleChangeSize(selectedPanel.id, w, h)}
        />
      )}
      {/* Facade mode: floating render preview (triggered by the NavBar Render button). */}
      {render && (
        <RenderPanel
          state={render}
          selectionCount={selectionCount}
          debug={debug}
          onRender={handleRender}
          onClose={() => setRender(null)}
        />
      )}
      {authResolved && !user && !guest && (
        <LoginModal enabled={firebaseEnabled} onGuest={() => setGuest(true)} />
      )}
    </>
  );
}
