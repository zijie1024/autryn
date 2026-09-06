export type ApprovalPersistence = {
  loadAllowList: (cwd: string) => Promise<Set<string>>;
  persistAllowedTool: (cwd: string, toolName: string) => Promise<void>;
};
