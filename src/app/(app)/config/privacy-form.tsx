import { deleteCustomerData } from "./privacy-actions";

export function PrivacyForm() {
  return (
    <section className="my-6 rounded border border-red-300 p-4">
      <h2 className="font-semibold">Delete customer data</h2>
      <p className="text-sm">
        Permanently removes this merchant’s cases, transcripts, evidence,
        sessions and pending messages for the number. This cannot be undone.
      </p>
      <form
        action={deleteCustomerData}
        className="mt-3 flex flex-wrap items-end gap-3"
      >
        <label className="text-sm">
          Phone including country code
          <input
            name="phone"
            required
            pattern="[0-9]{7,15}"
            className="ms-2 rounded border p-2"
            placeholder="905550001234"
          />
        </label>
        <label className="text-sm">
          <input type="checkbox" name="confirm" value="delete" required /> I
          confirm permanent deletion
        </label>
        <button className="rounded bg-red-700 px-3 py-2 text-white">
          Delete data
        </button>
      </form>
    </section>
  );
}
