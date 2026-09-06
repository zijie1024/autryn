export type ToolResultPolicy = {
  preferSummaryOnly: boolean;
  includeData: boolean;
  maxStringLength?: number;
  uiSummaryOnly?: boolean;
};

const DEFAULT_POLICY: ToolResultPolicy = {
  preferSummaryOnly: false,
  includeData: true,
  maxStringLength: 4000,
};

export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  switch (toolName) {
    case "list_files":
    case "glob_search":
    case "grep_search":
    case "file_info":
    case "mkdir":
    case "move_path":
      return {
        preferSummaryOnly: true,
        includeData: false,
        maxStringLength: 1000,
        uiSummaryOnly: true,
      };
    case "read_file":
      return {
        preferSummaryOnly: false,
        includeData: true,
        maxStringLength: 12000,
      };
    case "apply_patch":
    case "write_file":
    case "str_replace":
      return {
        preferSummaryOnly: false,
        includeData: true,
        maxStringLength: 4000,
      };
    default:
      return DEFAULT_POLICY;
  }
}
