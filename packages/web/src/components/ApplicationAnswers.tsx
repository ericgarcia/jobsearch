import { GrowText } from "./GrowText.tsx";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useChanges } from "../changes.ts";
import { asksAbout, Proposal } from "./Profile.tsx";

/**
 * The answers every application wants, kept in one place.
 *
 * Two sections, and they are not the same kind of thing.
 *
 * The standing answers are about your situation — whether you may work
 * somewhere, whether you need sponsoring, what notice you owe. Every
 * application asks them, the answer does not change between companies, and
 * it is not something to be worked out from a resume. Written once here and
 * copied as written.
 *
 * The self-identification answers are gender, race, veteran and disability
 * status, and pronouns. They are voluntary, they are yours, and leaving them
 * empty is a complete answer. They are stored apart from everything else and
 * never sent to the assistant — it is told which ones exist and nothing
 * more, and forms are filled from them by the app itself.
 */

const SELF_ID_LABELS: Record<string, string> = {
  gender: "Gender",
  race: "Race or ethnicity",
  veteran: "Veteran status",
  disability: "Disability status",
  pronouns: "Pronouns",
  transgender: "Transgender identity",
  sexual_orientation: "Sexual orientation",
  age: "Age or year of birth",
  location: "Country, when a survey asks",
};

export function ApplicationAnswers() {
  const [answers, setAnswers] = useState<{ topic: string; question: string; answer: string }[]>([]);
  const [topics, setTopics] = useState<Record<string, string>>({});
  const [selfId, setSelfId] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, { token: string; label: string }[] | undefined>>({});
  const [refused, setRefused] = useState<Set<string>>(new Set());
  const [standing, setStanding] = useState<"ask" | "never">("ask");
  const [pending, setPending] = useState<Awaited<ReturnType<typeof api.pendingEdit>>["pending"]>(null);

  const load = () => {
    void api.standingAnswers().then((data) => {
      setAnswers(data.answers);
      setTopics(data.topics);
    });
    void api.selfIdentification().then((data) => {
      setSelfId(data.values);
      setKeys([...data.keys]);
      setChoices(data.options ?? {});
    });
    void api.pendingEdit().then((answer) => setPending(answer.pending));
    void api.facts().then((data) => {
      setRefused(
        new Set(
          data.facts
            .filter((fact) => fact.state === "declined" || fact.share === "never")
            .map((fact) => fact.slug),
        ),
      );
      setStanding(data.voluntary_default);
    });
  };

  useEffect(load, []);
  // What the assistant is asking about arrives the same way a change does.
  /*
    Both: the card asking about an answer arrives on "focus", and the answer
    it writes lands on "profile". Listening to the first alone showed the
    question and then left the old value on the screen after it was answered.
  */
  useChanges(["focus", "profile"], load);

  const answerFor = (topic: string) =>
    answers.find((row) => row.topic === topic)?.answer ?? "";

  return (
    <>
      <h3>Answers every application wants</h3>
      <p className="editor-note">
        The same at every company, and legally significant, so they are copied exactly as you write
        them rather than worked out from your history. Anything left empty will be put to you when
        an application asks it.
      </p>

      {Object.entries(topics).map(([topic, question]) => {
        const asked = asksAbout(pending, "fact", { key: topic });
        if (asked) {
          /*
            The row exactly as it always is, with the question painted over
            it. Showing the answer as text instead of leaving the box there
            made the row shorter and moved the thirteen rows below it.
          */
          return (
            <label className="standing-row field-asked" key={topic}>
              <span className="standing-question">{question}</span>
              <GrowText
                key={answerFor(topic)}
                rows={1}
                defaultValue={answerFor(topic)}
                tabIndex={-1}
                aria-hidden
                readOnly
              />
              <Proposal asked={asked} name={`your answer to “${question}”`} onDone={load} />
            </label>
          );
        }
        return refused.has(topic) ? (
          <div className="standing-row" key={topic}>
            <span className="standing-question">{question}</span>
            <span className="standing-refused">You asked not to be asked this.</span>
            <button className="standing-aside" onClick={() => void api.reopenFact(topic).then(load)}>
              ask me again
            </button>
          </div>
        ) : (
          <label className="standing-row" key={topic}>
            <span className="standing-question">{question}</span>
            <GrowText
              /*
                Keyed on the value: these are uncontrolled, so without a key
                React keeps whatever the box was first rendered with and a
                refetch cannot put a new answer on the screen.
              */
              key={answerFor(topic)}
              rows={1}
              defaultValue={answerFor(topic)}
              placeholder="—"
              onBlur={(event) => {
                if (event.target.value === answerFor(topic)) return;
                void api.setStandingAnswer(topic, event.target.value).then(load);
              }}
            />
            {/*
              Separate from leaving the box empty, and deliberately so. Empty
              means the app has nothing and will ask you when a form wants
              it. This means you have told it, and it stops asking.
            */}
            <button
              className="standing-aside"
              onClick={() => void api.declineFact(topic, question).then(load)}
            >
              rather not say
            </button>
          </label>
        );
      })}

      <h3>Voluntary self-identification</h3>
      <p className="editor-note">
        Employers ask these for equal-opportunity reporting. They are voluntary, declining is
        always allowed, and it cannot count against you. Stored here only so your applications can
        be filled in: <b>these are never sent to the assistant</b>, which is told only which ones
        you have set. Leave any of them empty and it stays blank on every form.
      </p>
      <p className="editor-note">
        Storing one is not permission to send it. Every application asks which of these to
        include, question by question, and anything you do not name stays blank — so giving an
        employer your pronouns is not also giving them a disability status. The country here is the
        one a demographic survey asks for, which is a different question from the location on your
        profile: that one is a contact detail, and it is never used to answer this.
      </p>

      {/*
        The one standing decision this page offers about the section, and it
        only goes one way. There is no "always": a standing yes would
        disclose to every employer that asks, silently, which is what the
        per-application question exists to prevent. A standing no is
        different — it is a decision someone can make once and should not be
        asked to make forty times.
      */}
      <label className="standing-row">
        <span className="standing-question">Never raise any of this again</span>
        <input
          type="checkbox"
          checked={standing === "never"}
          onChange={(event) =>
            void api.setVoluntaryDefault(event.target.checked ? "never" : "ask").then(load)
          }
        />
        <span className="standing-refused">
          {standing === "never"
            ? "Voluntary sections are left blank and you are not asked."
            : "You will be asked which to include on each application."}
        </span>
      </label>

      {keys.map((key) => {
        const offered = choices[key];
        if (refused.has(key)) {
          return (
            <div className="standing-row" key={key}>
              <span className="standing-question">{SELF_ID_LABELS[key] ?? key}</span>
              <span className="standing-refused">
                You asked not to be asked this. Nothing is stored for it.
              </span>
              <button className="standing-aside" onClick={() => void api.reopenFact(key).then(load)}>
                ask me again
              </button>
            </div>
          );
        }
        return (
          <label className="standing-row" key={key}>
            <span className="standing-question">{SELF_ID_LABELS[key] ?? key}</span>
            {/*
              A list, not a box, wherever there is a fixed set of answers.
              Your answer is stored as one of these terms, and a form's own
              wording is translated into the same terms — which is how an
              application gets filled in without the answer itself ever being
              sent anywhere. Year of birth and country stay free text, because
              a form asking for those spells them out.
            */}
            {offered ? (
              <select
                value={selfId[key] ?? ""}
                onChange={(event) => {
                  void api.setSelfIdentification(key, event.target.value).then(load);
                }}
              >
                <option value="">—</option>
                {offered.map((choice) => (
                  <option key={choice.token} value={choice.token}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <GrowText
                key={`${key}:${selfId[key] ?? ""}`}
                rows={1}
                defaultValue={selfId[key] ?? ""}
                placeholder="—"
                onBlur={(event) => {
                  if (event.target.value === (selfId[key] ?? "")) return;
                  void api.setSelfIdentification(key, event.target.value).then(load);
                }}
              />
            )}
            {/*
              Not the same as "Prefer not to disclose" in the list above.
              That one is an answer the form itself offers, and it gets
              ticked. This one tells the app to stop asking, deletes whatever
              is stored, and leaves the field blank on every form.
            */}
            <button
              className="standing-aside"
              onClick={() => void api.declineSelfIdentification(key).then(load)}
            >
              stop asking
            </button>
          </label>
        );
      })}
    </>
  );
}
