/**
 * Messages collection — core live query pipeline.
 *
 * Architecture:
 * - chunks → (subquery: groupBy + count/min) → messages
 * - fn.select scans source collection for matching chunks, then materializes
 *
 * Since @tanstack/db@0.5.25 lacks `collect()`, we use a closure scan
 * over the chunksCollection to gather rows per messageId.
 */

import type { Collection } from "@tanstack/db";
import { count, createLiveQueryCollection, min } from "@tanstack/db";
import { materializeMessage } from "../materialize";
import type { ChunkRow } from "../schema";
import type { MessageRow } from "../types";

export interface MessagesCollectionOptions {
	chunksCollection: Collection<ChunkRow>;
}

/**
 * Creates the messages collection with groupBy + closure scan.
 *
 * `count(chunk.id)` changes on each new chunk → triggers fn.select
 * re-evaluation for that group only. The fn.select closure scans
 * the source chunksCollection for all rows matching the messageId.
 */
export function createMessagesCollection(
	options: MessagesCollectionOptions,
): Collection<MessageRow> {
	const { chunksCollection } = options;

	return createLiveQueryCollection({
		query: (q) => {
			const grouped = q
				.from({ chunk: chunksCollection })
				.groupBy(({ chunk }) => chunk.messageId)
				.select(({ chunk }) => ({
					messageId: chunk.messageId,
					rowCount: count(chunk.id),
					startedAt: min(chunk.createdAt),
				}));

			return q
				.from({ grouped })
				.orderBy(({ grouped }) => grouped.startedAt, "asc")
				.fn.select(({ grouped }) => {
					// Scan source collection for this message's chunks
					const rows: ChunkRow[] = [];
					for (const row of chunksCollection.values()) {
						if (row.messageId === grouped.messageId) rows.push(row);
					}
					return materializeMessage(rows);
				});
		},
		getKey: (row) => row.id,
	}) as unknown as Collection<MessageRow>;
}
