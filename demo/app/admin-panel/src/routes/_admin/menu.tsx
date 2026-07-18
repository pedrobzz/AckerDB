import { useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import {
  ImageOff,
  Pencil,
  Plus,
  Sparkles,
  UtensilsCrossed,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  Field,
  FormShell,
  Modal,
  PageHeader,
  QueryContent,
  SearchField,
  StatePanel,
} from "../../components/ui.tsx";
import {
  FIELD_LIMITS,
  errorMessage,
  imageSource,
  money,
  type MenuCategory,
  type MenuItem,
} from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/menu")({ component: MenuPage });

function MenuPage() {
  const catalog = useQuery(api.menu.catalog, {});
  const [categoryId, setCategoryId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);

  return (
    <div className="page page--full-height">
      <PageHeader
        title="Menu"
        subtitle="Shape categories, pricing, and every item guests can order."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() => setItemOpen(true)}
          >
            <Plus aria-hidden="true" /> Add item
          </button>
        }
      />

      <QueryContent state={catalog} loadingLabel="Loading the live menu…">
        {(categories) => {
          const allItems = categories.flatMap((category) =>
            category.items.map((item) => ({ item, category })),
          );
          const normalized = search.trim().toLowerCase();
          const visible = allItems.filter(({ item, category }) => {
            if (categoryId !== "all" && category.id.toString() !== categoryId)
              return false;
            return (
              !normalized ||
              item.name.toLowerCase().includes(normalized) ||
              item.description.toLowerCase().includes(normalized) ||
              category.name.toLowerCase().includes(normalized)
            );
          });
          return (
            <div className="menu-layout">
              <aside className="surface category-panel">
                <span className="text-ink-500 text-[9px] font-extrabold tracking-[0.1em] uppercase">
                  Categories
                </span>
                <div className="category-list">
                  <button
                    className={categoryId === "all" ? "active" : ""}
                    type="button"
                    onClick={() => setCategoryId("all")}
                  >
                    <UtensilsCrossed aria-hidden="true" />
                    <span>All items</span>
                    <b>{allItems.length}</b>
                  </button>
                  {categories.map((category) => (
                    <button
                      className={
                        categoryId === category.id.toString() ? "active" : ""
                      }
                      key={category.id.toString()}
                      type="button"
                      onClick={() => setCategoryId(category.id.toString())}
                    >
                      <span className="category-dot" aria-hidden="true" />
                      <span>{category.name}</span>
                      <b>{category.items.length}</b>
                    </button>
                  ))}
                </div>
                <button
                  className="dashed-button"
                  type="button"
                  onClick={() => setCategoryOpen(true)}
                >
                  <Plus aria-hidden="true" /> New category
                </button>
                <div className="live-note">
                  <Sparkles aria-hidden="true" />
                  <strong>Dinner menu is live</strong>
                  <p>Changes appear instantly in the customer app.</p>
                </div>
              </aside>

              <section className="menu-content">
                <div className="menu-toolbar">
                  <div>
                    <h2>
                      {categoryId === "all"
                        ? "All items"
                        : categories.find(
                            (category) => category.id.toString() === categoryId,
                          )?.name}
                    </h2>
                    <p>
                      {visible.length} of {allItems.length} menu items
                    </p>
                  </div>
                  <SearchField
                    value={search}
                    onChange={setSearch}
                    placeholder="Search menu"
                    label="Search menu"
                  />
                </div>

                {categories.length === 0 ? (
                  <section className="surface grow-state">
                    <StatePanel
                      title="No menu categories"
                      detail="Create a category before adding your first item."
                      action={
                        <button
                          className="button button--primary"
                          type="button"
                          onClick={() => setCategoryOpen(true)}
                        >
                          Create category
                        </button>
                      }
                    />
                  </section>
                ) : visible.length === 0 ? (
                  <section className="surface grow-state">
                    <StatePanel
                      title={
                        allItems.length === 0
                          ? "No menu items"
                          : "No matching menu items"
                      }
                      detail={
                        allItems.length === 0
                          ? "Add the first dish to publish it to guests."
                          : "Try another search or category."
                      }
                      action={
                        allItems.length === 0 ? (
                          <button
                            className="button button--primary"
                            type="button"
                            onClick={() => setItemOpen(true)}
                          >
                            Add item
                          </button>
                        ) : undefined
                      }
                    />
                  </section>
                ) : (
                  <div className="menu-card-grid">
                    {visible.map(({ item, category }) => (
                      <article
                        className={`menu-card${item.active ? "" : " menu-card--inactive"}`}
                        key={item.id.toString()}
                      >
                        <div className="menu-card__media">
                          {item.image ? (
                            <img src={imageSource(item.image)} alt="" />
                          ) : (
                            <ImageOff aria-hidden="true" />
                          )}
                          <span>{category.name}</span>
                          {!item.active && <b>Hidden</b>}
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => setEditing(item)}
                          >
                            <span className="sr-only">Edit {item.name}</span>
                            <Pencil aria-hidden="true" />
                          </button>
                        </div>
                        <div className="menu-card__body">
                          <div>
                            <h3>{item.name}</h3>
                            <strong>{money(item.priceCents)}</strong>
                          </div>
                          <p>{item.description}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {categoryOpen && (
                <CategoryDialog
                  categories={categories}
                  onClose={() => setCategoryOpen(false)}
                />
              )}
              {itemOpen && (
                <ItemDialog
                  categories={categories}
                  onClose={() => setItemOpen(false)}
                />
              )}
              {editing && (
                <ItemDialog
                  categories={categories}
                  item={editing}
                  onClose={() => setEditing(null)}
                />
              )}
            </div>
          );
        }}
      </QueryContent>
    </div>
  );
}

function CategoryDialog({
  categories,
  onClose,
}: Readonly<{ categories: readonly MenuCategory[]; onClose: () => void }>) {
  const create = useMutation(api.menu.createCategory);
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await create({ name, sortOrder: categories.length });
      toast.success(
        `${name.trim()} is ready for menu items.`,
        "Category created",
      );
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Could not create this category"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="New category"
      description="Categories organize the customer menu."
      onClose={onClose}
      size="small"
    >
      <FormShell
        onSubmit={submit}
        submitLabel="Create category"
        busy={busy}
        error={error}
        onCancel={onClose}
      >
        <Field label="Category name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={FIELD_LIMITS.name}
            placeholder="Seasonal specials"
          />
        </Field>
      </FormShell>
    </Modal>
  );
}

function ItemDialog({
  categories,
  item,
  onClose,
}: Readonly<{
  categories: readonly MenuCategory[];
  item?: MenuItem;
  onClose: () => void;
}>) {
  const create = useMutation(api.menu.createItem);
  const update = useMutation(api.menu.updateItem);
  const toast = useToast();
  const [categoryId, setCategoryId] = useState(
    item?.categoryId.toString() ?? categories[0]?.id.toString() ?? "",
  );
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [image, setImage] = useState(item?.image ?? "");
  const [price, setPrice] = useState(
    item ? (item.priceCents / 100).toFixed(2) : "",
  );
  const [active, setActive] = useState(item?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCategory = useMemo(
    () => categories.find((category) => category.id.toString() === categoryId),
    [categories, categoryId],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const priceCents = Math.round(Number(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      setError("Enter a valid price greater than zero.");
      return;
    }
    if (!categoryId) {
      setError("Create or choose a category.");
      return;
    }
    setBusy(true);
    setError(null);
    const values = {
      categoryId: BigInt(categoryId),
      name,
      description,
      image,
      priceCents,
      sortOrder: item?.sortOrder ?? selectedCategory?.items.length ?? 0,
    };
    try {
      if (item) await update({ id: item.id, ...values, active });
      else await create(values);
      toast.success(
        `${name.trim()} ${item ? "was updated" : "was added to the menu"}.`,
        item ? "Item updated" : "Item created",
      );
      onClose();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          `Could not ${item ? "update" : "create"} this item`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? `Edit ${item.name}` : "Add menu item"}
      description="Updates publish to both staff and guests in realtime."
      onClose={onClose}
    >
      {categories.length === 0 ? (
        <StatePanel
          title="Create a category first"
          detail="Every menu item belongs to a category."
        />
      ) : (
        <FormShell
          onSubmit={submit}
          submitLabel={item ? "Save changes" : "Add item"}
          busy={busy}
          error={error}
          onCancel={onClose}
        >
          <div className="form-grid">
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={FIELD_LIMITS.name}
                placeholder="Dish name"
              />
            </Field>
            <Field label="Category">
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                {categories
                  .filter((category) => category.active)
                  .map((category) => (
                    <option
                      key={category.id.toString()}
                      value={category.id.toString()}
                    >
                      {category.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
              maxLength={240}
              placeholder="Ingredients and preparation"
            />
          </Field>
          <div className="form-grid">
            <Field label="Price (USD)">
              <input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
                inputMode="decimal"
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                placeholder="18.00"
              />
            </Field>
            <Field
              label="Image URL or asset path"
              hint="For bundled images, use menu/file.png"
            >
              <input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                required
                maxLength={500}
                placeholder="menu/dish.png"
              />
            </Field>
          </div>
          {item && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
              <span>
                <strong>Visible to guests</strong>
                <small>Hidden items remain in staff history.</small>
              </span>
            </label>
          )}
        </FormShell>
      )}
    </Modal>
  );
}
