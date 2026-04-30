import { h } from 'preact';
import type { SystemMessage } from '../../shared/protocol.js';

export function SystemNotice({ message }: { message: SystemMessage }) {
  const classes = ['system-notice'];
  if (message.kind === 'error') classes.push('error');
  return <div class={classes.join(' ')}>{message.text}</div>;
}
