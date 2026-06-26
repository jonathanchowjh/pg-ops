import { Box, Text, useInput } from 'ink';
import { theme } from '../core/theme.js';

/**
 * Confirm modal for destructive actions (plan §G threat model).
 * Requires an explicit `y` — Enter does NOT confirm, so a reflexive return
 * keypress can never terminate a backend. Any other key cancels.
 */
export interface ConfirmModalProps {
  title: string;
  /** Lines of detail shown so the operator sees exactly what will happen. */
  details: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, details, onConfirm, onCancel }: ConfirmModalProps) {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.critical}
      paddingX={2}
      paddingY={1}
    >
      <Text color={theme.critical} bold>
        {title}
      </Text>
      {details.map((line, i) => (
        <Text key={i} color={theme.fg}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.warning}>Press y to confirm · any other key cancels</Text>
      </Box>
    </Box>
  );
}
