import { DNodeTypeV2, DVault } from "./typesv2";

export type Stage = "dev" | "prod" | "test";

export type DEngineQuery = {
  queryString: string;
  mode: DNodeTypeV2;
  opts?: QueryOpts;
};

export type DEngineMode = "exact" | "fuzzy";

export interface QueryOpts {
  /**
   * Should add to full nodes
   */
  fullNode?: boolean;
  /**
   * Just get one result
   */
  queryOne?: boolean;
  /**
   * Use with `createIfNew`
   * If true, create a stub node.
   * A stub node is not written to disk
   */
  stub?: boolean;
  /**
   * If node does not exist, create it?
   */
  createIfNew?: boolean;
  // --- hints
  // DEPPRECATE
  webClient?: boolean;
  initialQuery?: boolean;
  mode?: DNodeTypeV2;
}

export interface Resp<T> {
  data: T;
  error?: Error | null;
}

export type DendronConfig = {
  version: number;
  site: DendronSiteConfig;
  vaults: DVault[];
  betaFeatures?: boolean;
  lookupConfirmVaultOnCreate?: boolean;
};

export type HierarchyConfig = {
  publishByDefault?: boolean;
  noindexByDefault?: boolean;
  customFrontmatter?: CustomFMEntry[];
};

export type CustomFMEntry = {
  key: string;
  value: any;
};

export type DendronSiteFM = {
  published?: boolean;
  noindex?: boolean;
  nav_order?: number;
  nav_exclude?: boolean;
  permalink?: string;
};

export type DendronSiteConfig = {
  /**
   * If set, add prefix to all asset links
   */
  assetsPrefix?: string;

  /**
   * Copy assets from vault to site.
   * Default: true
   */
  copyAssets?: boolean;

  /**
   * Path to favicon. Should be somewhere inside your workspace.
   * Default: "favicon.ico"
   */
  siteFaviconPath?: string;

  /**
   * By default, the domain of your `siteHiearchies` page
   */
  siteIndex?: string;
  /**
   * Hiearchies to publish
   */
  siteHierarchies: string[];

  /**
   * Vaults that cannot be published from
   */
  privateVaults?: string[];

  /**
   * Where your site will be published.
   * Relative to Dendron workspace
   */
  siteRootDir: string;

  /**
   * Location of the github repo where your site notes are located.
   * By default, this is assumed to be your `workspaceRoot` if not set.
   */
  siteRepoDir?: string;

  /**
   * Folder where your notes will be kept. By default, "notes"
   */
  siteNotesDir?: string;

  /**
   * Url of site without trailing slash
   * eg. dendron.so
   */
  siteUrl?: string;
  /**
   * Cname used for github pages
   */
  githubCname?: string;

  /**
   * Website protocol. Default is https
   */
  siteProtocol?: "http" | "https";

  /** Pretty refs help you identify when content is embedded from elsewhere and provide links back to the source */
  usePrettyRefs?: boolean;

  /**
   * Control publication on a per hierarchy basis
   */
  config?: { [key: string]: HierarchyConfig };
};
