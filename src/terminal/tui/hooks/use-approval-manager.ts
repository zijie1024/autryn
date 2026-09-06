import { useEffect, useState } from "react";

import { type ApprovalDecision, type ApprovalRequest, globalApprovalManager } from "@/coding";

export function useApprovalManager() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    return globalApprovalManager.subscribe((req) => {
      // 队列为空时 req 为 null，否则为下一个请求对象
      setRequest(req);
    });
  }, []);

  const respond = (decision: ApprovalDecision) => {
    if (request) {
      globalApprovalManager.respond(decision);
    }
  };

  return {
    approvalRequest: request,
    respondToApproval: respond,
  };
}
