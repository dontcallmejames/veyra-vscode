import { h } from 'preact';
import type { UserMessage } from '../../shared/protocol.js';

export function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div class="bubble user">
      <div>{message.text}</div>
      {message.attachedFiles && message.attachedFiles.length > 0 && (
        <div class="attached-files">
          {message.attachedFiles.map((f) => (
            <div class="attached-file" key={f.path}>
              📎 {f.path} ({f.lines} lines{f.truncated ? ', truncated' : ''})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
