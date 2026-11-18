import { useEffect, useState } from "react";
import { api } from "../api.ts";

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
};

export function ApplicationAnswers() {
  const [answers, setAnswers] = useState<{ topic: string; question: string; answer: string }[]>([]);
  const [topics, setTopics] = useState<Record<string, string>>({});
  const [selfId, setSelfId] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<string[]>([]);

  const load = () => {
    void api.standingAnswers().then((data) => {
      setAnswers(data.answers);
      setTopics(data.topics);
    });
    void api.selfIdentification().then((data) => {
      setSelfId(data.values);
      setKeys([...data.keys]);
    });
  };

  useEffect(load, []);

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

      {Object.entries(topics).map(([topic, question]) => (
        <label className="standing-row" key={topic}>
          <span className="standing-question">{question}</span>
          <input
            defaultValue={answerFor(topic)}
            placeholder="—"
            onBlur={(event) => {
              if (event.target.value === answerFor(topic)) return;
              void api.setStandingAnswer(topic, event.target.value).then(load);
            }}
          />
        </label>
      ))}

      <h3>Voluntary self-identification</h3>
      <p className="editor-note">
        Employers ask these for equal-opportunity reporting. They are voluntary, declining is
        always allowed, and it cannot count against you. Stored here only so your applications can
        be filled in: <b>these are never sent to the assistant</b>, which is told only which ones
        you have set. Leave any of them empty and it stays blank on every form.
      </p>

      {keys.map((key) => (
        <label className="standing-row" key={key}>
          <span className="standing-question">{SELF_ID_LABELS[key] ?? key}</span>
          <input
            defaultValue={selfId[key] ?? ""}
            placeholder="—"
            onBlur={(event) => {
              if (event.target.value === (selfId[key] ?? "")) return;
              void api.setSelfIdentification(key, event.target.value).then(load);
            }}
          />
        </label>
      ))}
    </>
  );
}
