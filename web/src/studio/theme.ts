// The Takings screen in the board's own world: flat silk and undyed ground, rules not shadows, Barlow,
// condensed tabular figures. Every value reads a token from styles.css, so Studio's canvas, widgets,
// grids and charts follow the board when a token changes.
import { studioTheme } from "ag-studio";

const v = (name: string) => `var(--${name})`;
const rule = { width: 1, color: v("rule") };

// The board's chart theme order: silk first, then quiet neutrals. Never the ramp's gold or teal,
// which mean "paid" and "ready" on this board.
const CHART = ["#6B1540", "#5B5157", "#B5738F", "#8A7B84", "#3F0C26", "#D9B3C4", "#A39A9F", "#7E2A52"];
const palette = Object.fromEntries(CHART.flatMap((c, i) => [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]]));

export const takingsTheme = studioTheme.withParams({
  fontFamily: "Barlow, system-ui, sans-serif",
  fontSize: 15,
  textColor: v("ink"),
  foregroundColor: v("ink"),
  subtleTextColor: v("ink-2"),
  backgroundColor: v("ground"),
  borderColor: v("rule"),
  accentColor: v("silk"),
  iconColor: v("ink-2"),
  rowHoverColor: "#F1E9EC",

  // The canvas is the board's ground; no frame, no lift.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: v("ground-2"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: v("ground-2"),
  studioCanvasPadding: 12,
  studioCanvasFontFamily: "Barlow, system-ui, sans-serif",

  // Widgets are flat ground panels with a 1px rule, square like the grids.
  studioWidgetBackgroundColor: v("ground"),
  studioWidgetBorder: rule,
  studioWidgetBorderRadius: 0,
  studioWidgetPadding: 14,
  studioWidgetTitleFontFamily: "Barlow, system-ui, sans-serif",
  studioWidgetTitleFontSize: 13,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: v("ink-2"),
  studioWidgetSubtitleFontFamily: "Barlow, system-ui, sans-serif",
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: v("ink-mute"),
  studioWidgetCaptionFontFamily: "Barlow, system-ui, sans-serif",
  studioWidgetCaptionFontSize: 13,
  studioWidgetCaptionTextColor: v("ink-mute"),
  studioWidgetResizeBorderColor: v("silk"),

  studioPanelContainerBackgroundColor: v("ground"),
  studioPanelContainerBorder: rule,
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: v("rule"),
  studioPanelDividerActiveColor: v("silk"),
  studioPanelSectionBorderColor: v("rule"),
  studioPanelHeaderFontFamily: "Barlow, system-ui, sans-serif",
  studioPanelHeaderFontWeight: 600,
  studioPanelChevronButtonHoverBackgroundColor: "#F1E9EC",
  studioPanelChevronButtonHoverColor: v("silk"),
  studioToggleButtonActiveBackgroundColor: "#F0D6E2",
  studioToggleButtonActiveBorderColor: v("silk"),
  studioToggleButtonActiveColor: v("silk"),

  // Grid widgets: the board's header band and rules, at a reading density (not the 68px pass rows).
  gridFontFamily: "Barlow, system-ui, sans-serif",
  gridFontSize: 15,
  gridCellTextColor: v("ink"),
  gridHeaderBackgroundColor: "#EDE6DE",
  gridHeaderTextColor: v("ink-2"),
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 13,
  gridRowHeight: 40,
  gridRowBorder: rule,
  gridHeaderRowBorder: rule,
  gridPinnedRowBorder: rule,
  gridRowHoverColor: "#F1E9EC",
  gridWrapperBorder: false,

  chartFontFamily: "Barlow, system-ui, sans-serif",
  chartTextColor: v("ink"),
  chartSubtleTextColor: v("ink-2"),
  chartAxisLineColor: v("rule"),
  chartGridLineColor: v("rule"),
  ...palette,
});
