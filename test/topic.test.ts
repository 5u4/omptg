import { describe, expect, test } from "bun:test";
import { extractThreadId } from "../src/topic.ts";

describe("extractThreadId", () => {
	test("undefined for non-topic message (DM, regular group)", () => {
		expect(extractThreadId({})).toBeUndefined();
		expect(extractThreadId({ is_topic_message: false })).toBeUndefined();
	});

	test("undefined for General topic (is_topic_message: false even in forum)", () => {
		// Telegram's General topic carries no is_topic_message flag.
		expect(extractThreadId({ is_topic_message: false, message_thread_id: 1 }))
			.toBeUndefined();
	});

	test("returns thread id for a real topic message", () => {
		expect(extractThreadId({ is_topic_message: true, message_thread_id: 42 }))
			.toBe(42);
	});

	test("undefined when message is undefined (callback with no message)", () => {
		expect(extractThreadId(undefined)).toBeUndefined();
	});

	test("undefined when is_topic_message true but message_thread_id missing", () => {
		// Defensive: shouldn't happen per spec, but don't crash.
		expect(extractThreadId({ is_topic_message: true })).toBeUndefined();
	});
});
