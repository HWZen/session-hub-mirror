export interface HookApproval {
  event: string;
  command: string;
}

export function updateConfigYaml(source: string, command: string): string;
export function mergeAllowlist(source: string | null, approvals: HookApproval[]): string;
