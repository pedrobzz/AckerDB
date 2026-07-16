import { DbzzProvider, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

export const Route = createFileRoute("/")({
  component: AdminRoute,
  ssr: false,
});

function AdminRoute() {
  return (
    <DbzzProvider
      config={{
        url: import.meta.env.VITE_DBZZ_URL ?? "http://127.0.0.1:3212",
        credential: { kind: "anonymous" },
      }}
    >
      <TaskList />
    </DbzzProvider>
  );
}

function TaskList() {
  const tasks = useQuery(api.tasks.list, {});
  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const removeTask = useMutation(api.tasks.remove);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setError(null);
      await createTask({ title });
      setTitle("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create item");
    }
  }

  return (
    <main>
      <section>
        <header>
          <p>Workspace</p>
          <h1>Tasks</h1>
        </header>

        <form onSubmit={submit}>
          <input
            aria-label="Task title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add an item"
            value={title}
          />
          <button disabled={title.trim().length === 0} type="submit">
            Add
          </button>
        </form>

        {error && <p role="alert">{error}</p>}
        {tasks.status === "pending" && <p>Loading…</p>}
        {tasks.status === "error" && <p role="alert">{tasks.error.message}</p>}
        {tasks.status === "success" && (
          <ul>
            {tasks.data.map((task) => (
              <li key={task.id.toString()}>
                <label>
                  <input
                    checked={task.completed}
                    onChange={() =>
                      void updateTask({
                        id: task.id,
                        title: task.title,
                        completed: !task.completed,
                      })
                    }
                    type="checkbox"
                  />
                  <span>{task.title}</span>
                </label>
                <button onClick={() => void removeTask({ id: task.id })} type="button">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
