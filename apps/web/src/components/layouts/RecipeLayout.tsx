import { useState } from 'react';
import { ChefHat, Minus, Plus, UtensilsCrossed } from 'lucide-react';
import { blocksByKey, parseQuantity, scaleIngredient } from '@nicotes/shared';
import { useLocalState } from '../../lib/storage';
import { InlineMarkdown } from '../Markdown';
import { StepRunner, type Step } from './StepRunner';
import { TimerChips, TimerTray, useTimers } from './Timers';
import { isList, plainText, stepsFrom, type LayoutProps } from './types';

/** Languages that write 0,5 rather than 0.5. */
const COMMA = new Set(['de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'cs', 'da', 'sv', 'nb', 'fi', 'ru', 'tr']);

/** Words in ingredient lines that say nothing about which ingredient it is. */
const FILLER = new Set(
  (
    'cups cup tablespoons tablespoon teaspoons teaspoon pinch pieces piece large small medium fresh chopped sliced diced ' +
    'softened melted room temperature about some more prise stück große großer kleine kleiner frisch frische gehackt ' +
    'gewürfelt weich weiche geschmolzen etwas nach belieben packung päckchen dose'
  ).split(' '),
);

/** Ingredient keywords for finding them in a step ("200 g dark chocolate" → chocolate, dark). */
function keywords(text: string): string[] {
  const rest = parseQuantity(text)?.rest ?? text;
  return [...new Set(plainText(rest).toLowerCase().match(/\p{L}{4,}/gu) ?? [])].filter((w) => !FILLER.has(w));
}

/**
 * A recipe to cook from: servings that scale the amounts, ingredients to tick off while
 * gathering them (not saved), steps with timers, and a full-screen cook mode.
 */
export function RecipeLayout({ pageId, notebookId, title, blocks, spec }: LayoutProps) {
  const lists = blocksByKey(blocks, spec.ingredients).filter(isList);
  const steps: Step[] = stepsFrom(blocksByKey(blocks, spec.steps));
  const base = spec.servings;
  const [servings, setServings] = useState(base ?? 1);
  const [have, setHave] = useState<Set<string>>(() => new Set());
  const [cooking, setCooking] = useState(false);
  const [current, setCurrent] = useLocalState(`nicotes.step.${pageId}`, 0);
  const timers = useTimers();
  const factor = base ? servings / base : servings;
  const decimal = spec.language && COMMA.has(spec.language) ? ',' : '.';
  const scaled = (text: string) => scaleIngredient(text, factor, decimal);

  const ingredients = lists.flatMap((list) => list.items.map((item, n) => ({ key: `${list.key}:${n}`, text: item.text })));
  const needs = (step: Step) => {
    const text = plainText([step.text, ...step.details].join(' ')).toLowerCase();
    return ingredients
      .filter((ing) => keywords(ing.text).some((w) => new RegExp(`(?<!\\p{L})${w}`, 'u').test(text)))
      .map((ing) => scaled(ing.text));
  };

  if (!lists.length && !steps.length) {
    return (
      <div className="layout-empty">
        <UtensilsCrossed size={26} className="muted" />
        <p className="muted">No ingredients or steps found. Let the AI pick them, or choose another layout.</p>
      </div>
    );
  }

  // Big batches change by a quarter (48 → 60), so amounts stay round; small ones by one.
  const unit = base ? (base > 8 ? Math.round(base / 4) : 1) : 0.5;
  const step = (n: number) => setServings((s) => Math.max(unit, s + n * unit));
  const groupTitle = (heading: string[]) => (lists.length > 1 ? heading.at(-1) : undefined);

  return (
    <div className="recipe">
      <div className="recipe-bar">
        <div className="servings" role="group" aria-label={base ? 'Servings' : 'Amounts'}>
          <button className="icon-btn" aria-label={base ? 'Fewer servings' : 'Smaller amounts'} onClick={() => step(-1)}>
            <Minus size={16} />
          </button>
          <span>{base ? `${servings} ${servings === 1 ? 'serving' : 'servings'}` : `${String(servings).replace('.', decimal)}× amounts`}</span>
          <button className="icon-btn" aria-label={base ? 'More servings' : 'Larger amounts'} onClick={() => step(1)}>
            <Plus size={16} />
          </button>
        </div>
        {steps.length > 0 && (
          <button className="btn btn-primary" onClick={() => setCooking(true)}>
            <ChefHat size={16} /> Start cooking
          </button>
        )}
      </div>

      <div className="recipe-grid">
        {lists.length > 0 && (
          <section className="recipe-ingredients" aria-label="Ingredients">
            <h3>Ingredients</h3>
            {lists.map((list) => (
              <div key={list.key}>
                {groupTitle(list.heading) && <h4>{plainText(groupTitle(list.heading)!)}</h4>}
                <ul>
                  {list.items.map((item, n) => {
                    const key = `${list.key}:${n}`;
                    return (
                      <li key={key} className={have.has(key) ? 'have' : undefined} style={{ marginLeft: item.depth * 18 }}>
                        <label>
                          <input
                            type="checkbox"
                            className="task-check"
                            checked={have.has(key)}
                            onChange={() =>
                              setHave((s) => {
                                const next = new Set(s);
                                if (!next.delete(key)) next.add(key);
                                return next;
                              })
                            }
                          />
                          <span>
                            <InlineMarkdown text={scaled(item.text)} notebookId={notebookId} />
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}

        {steps.length > 0 && (
          <section className="recipe-steps" aria-label="Steps">
            <h3>Steps</h3>
            <ol>
              {steps.map((s) => (
                <li key={s.key}>
                  <InlineMarkdown text={s.text} notebookId={notebookId} />
                  {s.details.length > 0 && (
                    <ul>
                      {s.details.map((d, i) => (
                        <li key={i}>
                          <InlineMarkdown text={d} notebookId={notebookId} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <TimerChips text={[s.text, ...s.details].join(' ')} timers={timers} />
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {cooking && (
        <StepRunner
          title={title || 'Cook mode'}
          steps={steps}
          notebookId={notebookId}
          timers={timers}
          needs={needs}
          index={current}
          onIndex={setCurrent}
          onClose={() => setCooking(false)}
        />
      )}
      {!cooking && <TimerTray timers={timers} />}
    </div>
  );
}
