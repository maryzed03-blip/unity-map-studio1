import { describe, it, expect, vi, beforeEach } from "vitest";

const cAddDoc = vi.fn(async (..._a: unknown[]) => ({ id: "newFolderId" }));
const cUpdateDoc = vi.fn(async (..._a: unknown[]) => {});
const cDeleteDoc = vi.fn(async (..._a: unknown[]) => {});
const cGetDocs = vi.fn(async (..._a: unknown[]) => ({ docs: [] as Array<{ id: string }> }));
const cOnSnapshot = vi.fn((..._a: unknown[]) => () => {});

vi.mock("../quota-guard", () => ({
  cAddDoc: (...a: unknown[]) => cAddDoc(...a),
  cUpdateDoc: (...a: unknown[]) => cUpdateDoc(...a),
  cDeleteDoc: (...a: unknown[]) => cDeleteDoc(...a),
  cGetDocs: (...a: unknown[]) => cGetDocs(...a),
  cOnSnapshot: (...a: unknown[]) => cOnSnapshot(...a),
  cGetDoc: vi.fn(),
  cSetDoc: vi.fn(),
}));

vi.mock("../firebase", () => ({ db: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: (..._a: unknown[]) => ({ __coll: true }),
  doc: (..._a: unknown[]) => ({ __doc: true }),
  query: (..._a: unknown[]) => ({ __q: true }),
  where: (..._a: unknown[]) => ({ __w: true }),
  serverTimestamp: () => "ts",
}));

const deleteProjectMock = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../projects", () => ({
  deleteProject: (...a: unknown[]) => deleteProjectMock(...a),
}));
vi.mock("../canvas/storage", () => ({ mapStore: { deleteRemotePayload: vi.fn() } }));

import * as folders from "../folders";

beforeEach(() => {
  cAddDoc.mockClear();
  cUpdateDoc.mockClear();
  cDeleteDoc.mockClear();
  cGetDocs.mockReset();
  cGetDocs.mockResolvedValue({ docs: [] });
  cOnSnapshot.mockReset();
  deleteProjectMock.mockClear();
});

describe("folders", () => {
  it("createFolder writes one doc with trimmed name", async () => {
    const id = await folders.createFolder("u1", "  Math  ");
    expect(id).toBe("newFolderId");
    expect(cAddDoc).toHaveBeenCalledTimes(1);
    const data = cAddDoc.mock.calls[0][1] as { name: string; ownerId: string };
    expect(data.name).toBe("Math");
    expect(data.ownerId).toBe("u1");
  });

  it("createFolder rejects empty name", async () => {
    await expect(folders.createFolder("u1", "   ")).rejects.toThrow();
  });

  it("renameFolder updates with trimmed name", async () => {
    await folders.renameFolder("f1", "  New  ");
    expect(cUpdateDoc).toHaveBeenCalledTimes(1);
    const data = cUpdateDoc.mock.calls[0][1] as { name: string };
    expect(data.name).toBe("New");
  });

  it("moveProjectToFolder updates folderId", async () => {
    await folders.moveProjectToFolder("p1", "f1");
    const d1 = cUpdateDoc.mock.calls[0][1] as { folderId: string | null };
    expect(d1.folderId).toBe("f1");
    await folders.moveProjectToFolder("p1", null);
    const d2 = cUpdateDoc.mock.calls[1][1] as { folderId: string | null };
    expect(d2.folderId).toBeNull();
  });

  it("deleteFolder default detaches projects (no delete)", async () => {
    cGetDocs.mockResolvedValue({ docs: [{ id: "p1" }, { id: "p2" }] });
    await folders.deleteFolder("f1", "u1");
    expect(cUpdateDoc).toHaveBeenCalledTimes(2);
    expect(cDeleteDoc).toHaveBeenCalledTimes(1);
    expect(deleteProjectMock).not.toHaveBeenCalled();
  });

  it("deleteFolder with deleteProjects:true cascades", async () => {
    cGetDocs.mockResolvedValue({ docs: [{ id: "p1" }, { id: "p2" }] });
    await folders.deleteFolder("f1", "u1", { deleteProjects: true });
    expect(deleteProjectMock).toHaveBeenCalledTimes(2);
    expect(cUpdateDoc).not.toHaveBeenCalled();
    expect(cDeleteDoc).toHaveBeenCalledTimes(1);
  });

  it("subscribeMyFolders forwards docs and sorts by name", () => {
    let captured: folders.Folder[] = [];
    cOnSnapshot.mockImplementationOnce((..._args: unknown[]) => {
      const cb = _args[1] as (s: unknown) => void;
      cb({
        docs: [
          { id: "b", data: () => ({ ownerId: "u1", name: "Zeta" }) },
          { id: "a", data: () => ({ ownerId: "u1", name: "Alpha" }) },
        ],
      });
      return () => {};
    });
    folders.subscribeMyFolders("u1", (f) => (captured = f));
    expect(captured.map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  });
});
