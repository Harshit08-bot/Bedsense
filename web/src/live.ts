import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io } from "socket.io-client";

/** The server says WHAT changed; we refetch that data through the normal authenticated API. */
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = io({ path: "/socket.io" });
    socket.on("changed", (topic: string) =>
      qc.invalidateQueries({ queryKey: [topic] }),
    );
    return () => {
      socket.disconnect();
    };
  }, [qc]);
}
