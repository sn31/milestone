import { AllCommunityModule, ModuleRegistry, createPart, iconSetQuartzLight, themeQuartz } from "ag-grid-community";

// Registered once per browser bundle; safe to call on the server too.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid in Milestone's tokens (DESIGN.md 1.1-1.3). Every colour is a CSS variable, so the grid follows the page's
 * theme (OS preference or html[data-theme]) with no second theme object and no light grid on a dark page.
 * Cells are Geist; headers are the mono label style; hairlines everywhere; no shadows.
 */
const params = {
  browserColorScheme: "inherit",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--fg)",
  textColor: "var(--fg)",
  subtleTextColor: "var(--fg-faint)",
  accentColor: "var(--focus)",
  borderColor: "var(--hairline)",
  chromeBackgroundColor: "var(--surface)",
  headerBackgroundColor: "var(--surface)",
  headerTextColor: "var(--fg-faint)",
  headerFontFamily: "var(--font-mono)",
  headerFontSize: 11,
  headerFontWeight: 400,
  headerHeight: 40,
  headerRowBorder: { color: "var(--hairline)" },
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "var(--hairline)",
  headerCellHoverBackgroundColor: "var(--surface-raised)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  dataFontSize: 13,
  rowHeight: 44,
  spacing: 6,
  cellHorizontalPadding: 14,
  rowBorder: { color: "var(--hairline)" },
  columnBorder: false,
  oddRowBackgroundColor: "var(--surface)",
  rowHoverColor: "color-mix(in oklab, var(--fg) 4%, transparent)",
  selectedRowBackgroundColor: "color-mix(in oklab, var(--state-funded) 10%, transparent)",
  iconColor: "var(--fg-faint)",
  iconSize: 13,
  wrapperBorder: { color: "var(--hairline)" },
  wrapperBorderRadius: 10,
  borderRadius: 4,
  // popups, filter menus and inputs: raised surface, strong hairline, no drop shadows
  menuBackgroundColor: "var(--surface-raised)",
  menuBorder: { color: "var(--hairline-strong)" },
  menuTextColor: "var(--fg)",
  menuShadow: "none",
  popupShadow: "none",
  dropdownShadow: "none",
  cardShadow: "none",
  dialogShadow: "none",
  tooltipBackgroundColor: "var(--surface-raised)",
  tooltipTextColor: "var(--fg)",
  tooltipBorder: { color: "var(--hairline-strong)" },
  inputBackgroundColor: "var(--surface-sunken)",
  inputBorder: { color: "var(--hairline-strong)" },
  inputBorderRadius: 7,
  inputTextColor: "var(--fg)",
  inputPlaceholderTextColor: "var(--fg-faint)",
  inputFocusBorder: { color: "var(--focus)" },
  inputFocusShadow: "none",
  focusShadow: { radius: 2, spread: 0, color: "var(--focus)" },
  paginationPanelHeight: 44,
  modalOverlayBackgroundColor: "color-mix(in oklab, var(--bg) 66%, transparent)",
} as const;

/** The details DESIGN.md asks for that the params cannot express: mono uppercase heads, tabular figures. */
const typeset = createPart({
  feature: "milestoneType",
  css: `
.ag-header-cell-text { text-transform: uppercase; letter-spacing: 0.12em; }
.ag-header-cell .ag-header-cell-filter-button:not(.ag-filter-active), .ag-header-cell-resize::after { opacity: 0; transition: opacity 200ms var(--ease-glide); }
.ag-header-cell:hover .ag-header-cell-filter-button, .ag-header-cell:focus-within .ag-header-cell-filter-button, .ag-header-cell:hover .ag-header-cell-resize::after { opacity: 1; }
.ag-paging-panel, .ag-paging-row-summary-panel, .ag-paging-description { font-family: var(--font-mono); font-size: 11px; color: var(--fg-faint); font-variant-numeric: tabular-nums; }
.ag-paging-panel { border-top-color: var(--hairline); }
.ag-paging-number { color: var(--fg); }
.ag-overlay-no-rows-center { font-family: var(--font-mono); font-size: 12px; color: var(--fg-faint); }
.ag-full-width-container .ag-row, .ag-full-width-row { background: var(--surface); }
.ag-row-hover.ag-full-width-row::before { background: transparent; }
`,
});

/** Self-contained grid: hairline wrapper with panel radius. Looks like a `Panel variant="solid"` on its own. */
export const gridTheme = themeQuartz.withPart(iconSetQuartzLight).withPart(typeset).withParams(params);

/** For a grid placed inside a `Panel variant="solid" padded={false}`: no wrapper border or radius of its own. */
export const gridThemeInset = gridTheme.withParams({ wrapperBorder: false, wrapperBorderRadius: 0 });
