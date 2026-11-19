import { useEffect, useState } from "react";
import { api, type Wish } from "../api.ts";

/**
 * What the app would not let the assistant do.
 *
 * A proposal card can be answered three ways — take the text in the box,
 * change nothing, remove the row — and that set is closed on purpose: the
 * server has to carry an answer out, and what a button does must never come
 * from text that was read out of somebody's resume or a job posting.
 *
 * The cost of a closed set is that it is a guess about what the work needs.
 * The assistant is what meets the cases the guess missed, and until this
 * page existed those cases went nowhere: it explained the limit in the
 * thread, the thread scrolled away, and the next conversation hit the same
 * wall with no record that the first one had.
 *
 * So this is the record. Each row is an answer the assistant wanted, in its
 * own words, with the number of times it has wanted it. Nothing here changes
 * what a card does — adding an answer type is a decision for whoever reads
 * this page, which is the point of it being a page rather than a button.
 */
export function Admin() {
  const [wished, setWished] = useState<Wish[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api
      .wishedActions()
      .then((answer) => setWished(answer.wished))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="admin-pane">
      <h2>Answers the assistant wanted</h2>
      <p className="field-why">
        A card can take the text in the box, change nothing, or remove the row. These are the
        answers it asked for instead, with how often it has asked. Nothing here is live: an
        answer becomes a button only when it is built as one.
      </p>

      {failed && <p className="field-why">That list could not be loaded.</p>}
      {wished && wished.length === 0 && (
        <p className="field-why">Nothing yet. The three answers have been enough so far.</p>
      )}

      {wished && wished.length > 0 && (
        <table className="wishes">
          <thead>
            <tr>
              <th>Answer</th>
              <th>What it would do</th>
              <th>Asked</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {wished.map((wish) => (
              <tr key={wish.id}>
                <td className="wish-name">{wish.name}</td>
                <td>{wish.why}</td>
                <td className="wish-votes">{wish.votes}</td>
                <td className="wish-when">{wish.last_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
