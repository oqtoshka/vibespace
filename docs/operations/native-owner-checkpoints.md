# Native diagnostic owner checkpoints

`createCodexOwnerCheckpoints` is a dormant internal adapter. No runtime registration,
HTTP endpoint, provider command or authenticated production ACK producer is installed.
Its `checkpointed(scope, nativeIds)` result can feed the diagnostic host only after a
trusted host bridge supplies the three dependencies below. Tests use a controlled
owner channel; they do not prove that live native children can acknowledge a checkpoint.

The observer must identify the exact owner independently of the request, verify the
application/native/generation mapping, and return the complete actual root/descendant
residency set with an owner-specific revision and an exact native-child-to-owner mapping. An empty inventory, idle status,
completed task, restored session or process exit supplies no checkpoint consent.

The ACK transport must authenticate the owner independently of all payload fields.
It must obtain a distinct explicit authenticated receipt for every native root/child,
each acknowledging the immutable full challenge and its specific native ID. The challenge
binds the full scope, root owner, exact child-owner mapping, residency revision, exact
native IDs, purpose, nonce and deadline. Missing or duplicate child receipts are refused.
A reply that merely echoes a supplied owner ID is not authenticated. Parent-authored
child replies, ordinary message-delivery receipts and resource-release verdicts cannot
stand in for individual child-owner acknowledgements. If separate child owners exist,
the bridge must gather every child receipt explicitly. A single aggregate parent ACK
cannot pass this service, even if it lists all children. This adapter does not manufacture
child receipts or establish the bridge's trust.

The invalidation subscription must cover lifecycle changes, membership/residency
changes, owner disconnect and identity/generation changes for the root and every owned
descendant, starting before the first inventory read. Missing or incomplete observation
must fail closed. The adapter re-reads inventory after the explicit ACK and requires
the same revision, identities and full set. It rejects stale, replayed, partial,
cross-session or cross-owner responses and admits one pending challenge per app owner.

Each challenge has a one-use random nonce and a deadline of at most 1500 ms, enforced by
both wall and monotonic clocks. Async observer/ACK timeouts, rejection, backward clocks,
notifications and cleanup failures return false. No reusable checkpoint cache exists.
Subscription removal is attempted after every settlement; a cleanup failure rejects
the ACK. Unresolved injected work cannot be cancelled by this adapter, so a production
bridge must also bound its own requests and guarantee listener removal.

The bridge remains missing. Future wiring must retain the diagnostic routing host lease,
all-peer native idle checks, request/approval holds and synchronous final identity checks.
A true result attests only this bounded challenge; it does not itself transfer ownership,
stop a process, release a resource or authorize installation/restart.
