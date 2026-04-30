import { h } from 'preact';
import type { UserMessage } from '../../shared/protocol.js';

export function UserBubble({ message }: { message: UserMessage }) {
  return <div class="bubble user">{message.text}</div>;
}
