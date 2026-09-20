import { version } from "../package.json" with { type: "json" };

/** The version the bundle announces is the one package.json carried when it was built, so a publish step that bumps
 * the manifest must do so before the build. */
export const VERSION: string = version;
