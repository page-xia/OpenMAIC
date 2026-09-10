import { describe, expect, it } from 'vitest';
import { parseActionsFromStructuredOutput, postProcessInteractiveHtml } from '@openmaic/generation';

describe('action parser', () => {
  it('repairs malformed structured output and preserves interleaving', () => {
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"text","content":"Start"},{"type":"action","name":"widget_setState","params":{}}',
      'interactive',
      ['widget_setState'],
    );
    expect(actions).toEqual([
      expect.objectContaining({ type: 'speech', text: 'Start' }),
      expect.objectContaining({ type: 'widget_setState', state: {} }),
    ]);
  });

  it('filters slide-only actions from non-slide scenes', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"action","name":"spotlight","params":{"elementId":"x"}}]',
        'quiz',
      ),
    ).toEqual([]);
  });

  it('drops action wrappers whose name is missing or not a real action type', () => {
    // A truncated trailing wrapper (partial-json keeps only the complete keys)
    // and a degenerate `name:"action"` turn both used to yield an Action with a
    // bogus type, which validateScene later rejected — failing the whole document.
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"action","name":"spotlight","params":{"elementId":"x"}},' +
        '{"type":"text","content":"hi"},' +
        '{"type":"action"},' +
        '{"type":"action","name":"action"}]',
      'slide',
    );
    expect(actions.map((a) => a.type)).toEqual(['spotlight', 'speech']);
  });

  it('keeps a truncated trailing action wrapper from poisoning the array', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"text","content":"hi"},{"type":"action","name":"spotl',
        'slide',
      ).map((a) => a.type),
    ).toEqual(['speech']);
  });
});

describe('interactive HTML post-processing', () => {
  it('converts math, protects scripts, and injects KaTeX once', () => {
    const source =
      '<html><head></head><body>$x+1$<script>const price = "$5";</script></body></html>';
    const once = postProcessInteractiveHtml(source);
    const twice = postProcessInteractiveHtml(once);
    expect(once).toContain('\\(x+1\\)');
    expect(once).toContain('const price = "$5";');
    expect(once).toContain('katex.min.css');
    expect(twice.match(/katex\.min\.css/g) ?? []).toHaveLength(1);
  });
});
