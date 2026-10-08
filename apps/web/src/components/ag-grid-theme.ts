import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

// Registered once per browser bundle; safe to call on the server too.
ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({ fontSize: 13, spacing: 6 });
