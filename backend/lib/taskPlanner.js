import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_PLAN = {
  remove_duplicates: true,
  standardize_dates: true,
  flag_missing_dates: false,
  preserve_blanks: true,
  summarize_changes: true,
  validate_output: true
};

function parseClaudeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude response did not include JSON');
    return JSON.parse(match[0]);
  }
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export async function interpretTaskIntent(task, csvPreview, apiKey, model) {
  if (!task.trim()) {
    return {
      plan: DEFAULT_PLAN,
      fallback_used: true,
      note: 'No task text provided, using default cleaning plan.'
    };
  }

  if (!apiKey) {
    return {
      plan: DEFAULT_PLAN,
      fallback_used: true,
      note: 'ANTHROPIC_API_KEY not configured. Using default cleaning plan.'
    };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 600,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            'You interpret user intent for a CSV-cleaning backend. Return strict JSON only.',
            'Do not perform transformation yourself.',
            '',
            `Task: ${task}`,
            '',
            'CSV preview (first lines):',
            csvPreview || '(no CSV preview)',
            '',
            'Return JSON with booleans only:',
            '{',
            '  "remove_duplicates": true|false,',
            '  "standardize_dates": true|false,',
            '  "flag_missing_dates": true|false,',
            '  "preserve_blanks": true|false,',
            '  "summarize_changes": true|false,',
            '  "validate_output": true|false',
            '}'
          ].join('\n')
        }
      ]
    });

    const textBlock = message.content.find((part) => part.type === 'text');
    if (!textBlock) {
      throw new Error('No text response from Claude.');
    }

    const parsed = parseClaudeJSON(textBlock.text);

    const plan = {
      remove_duplicates: toBool(parsed.remove_duplicates, DEFAULT_PLAN.remove_duplicates),
      standardize_dates: toBool(parsed.standardize_dates, DEFAULT_PLAN.standardize_dates),
      flag_missing_dates: toBool(parsed.flag_missing_dates, DEFAULT_PLAN.flag_missing_dates),
      preserve_blanks: toBool(parsed.preserve_blanks, DEFAULT_PLAN.preserve_blanks),
      summarize_changes: toBool(parsed.summarize_changes, DEFAULT_PLAN.summarize_changes),
      validate_output: toBool(parsed.validate_output, DEFAULT_PLAN.validate_output)
    };

    return {
      plan,
      fallback_used: false,
      note: null
    };
  } catch (error) {
    return {
      plan: DEFAULT_PLAN,
      fallback_used: true,
      note: `Claude task interpretation unavailable (${error.message}). Using default cleaning plan.`
    };
  }
}

export async function generateSummaryWithClaude(
  context,
  apiKey,
  model
) {
  const defaultSummary = `Processed ${context.rows_input} input rows into ${context.rows_output} output rows. Removed ${context.duplicates_removed} exact duplicate${context.duplicates_removed === 1 ? '' : 's'}. Normalized ${context.dates_normalized} date value${context.dates_normalized === 1 ? '' : 's'}. Detected ${context.missing_values_detected} missing value${context.missing_values_detected === 1 ? '' : 's'}.`;

  if (!apiKey) {
    return { summary: defaultSummary, used_claude: false };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 180,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            'Write one concise sentence summarizing this CSV-cleaning run.',
            'Do not invent facts. Keep under 40 words.',
            JSON.stringify(context)
          ].join('\n')
        }
      ]
    });

    const textBlock = message.content.find((part) => part.type === 'text');
    const summary = textBlock?.text?.trim();
    if (!summary) {
      return { summary: defaultSummary, used_claude: false };
    }

    return { summary, used_claude: true };
  } catch {
    return { summary: defaultSummary, used_claude: false };
  }
}

export async function advisoryResponse(task, apiKey, model) {
  const defaultBody = [
    'No CSV file was uploaded, so no execution occurred.',
    '',
    'Suggested plan:',
    '1. Inspect headers and sample rows.',
    '2. Normalize headers and trim whitespace.',
    '3. Standardize dates and handle missing values.',
    '4. Remove exact duplicates and validate output.'
  ].join('\n');

  if (!apiKey) {
    return {
      result: defaultBody,
      fallback_used: true,
      note: 'ANTHROPIC_API_KEY not configured. Returning default advisory plan.'
    };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: model || 'claude-sonnet-4-5',
      max_tokens: 300,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            'A user gave a task but no CSV file.',
            'Return a concise advisory strategy only. No fabricated execution results.',
            `Task: ${task || '(no task provided)'}`
          ].join('\n')
        }
      ]
    });

    const textBlock = message.content.find((part) => part.type === 'text');
    return {
      result: textBlock?.text?.trim() || defaultBody,
      fallback_used: false,
      note: null
    };
  } catch (error) {
    return {
      result: defaultBody,
      fallback_used: true,
      note: `Claude advisory generation unavailable (${error.message}). Returning default advisory plan.`
    };
  }
}
