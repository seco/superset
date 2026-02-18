import type { Collection } from "@tanstack/db";
import type { UIMessage } from "ai";
import { useMemo } from "react";
import { messageRowToUIMessage } from "../materialize";
import type { MessageRow } from "../types";
import { useCollectionData } from "./useCollectionData";

/**
 * Subscribe to a MessageRow collection and return AI SDK UIMessage[].
 */
export function useMessages(
	messagesCollection: Collection<MessageRow>,
): (UIMessage & { actorId: string; createdAt: Date })[] {
	const rows = useCollectionData(messagesCollection);
	return useMemo(() => rows.map(messageRowToUIMessage), [rows]);
}
