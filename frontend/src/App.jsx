import { useMemo, useState } from "react";
import { ethers } from "ethers";
import deployed from "./deployedAddress.json";
import "./style.css";

const ESCROW_ABI = [
  "function client() view returns (address)",
  "function freelancer() view returns (address)",
  "function approvalThreshold() view returns (uint256)",
  "function getApprovers() view returns (address[])",
  "function getMilestoneCount() view returns (uint256)",
  "function getContractBalance() view returns (uint256)",
  "function getMilestone(uint256 milestoneId) view returns (string description, uint256 amount, string proofURI, string freelancerResponse, uint256 approvalCount, uint256 submissionVersion, uint8 status)",
  "function hasApprovedCurrentSubmission(uint256 milestoneId, address approver) view returns (bool)",
  "function getLatestDispute(uint256 milestoneId) view returns (bool exists, address raisedBy, string reason, string freelancerResponse, bool resolved, uint256 timestamp)",
  "function submitMilestone(uint256 milestoneId, string proofURI)",
  "function approveMilestone(uint256 milestoneId)",
  "function raiseDispute(uint256 milestoneId, string reason)",
  "function respondToDispute(uint256 milestoneId, string response)",
  "function resubmitMilestone(uint256 milestoneId, string newProofURI, string response)"
];

const STATUS_LABELS = ["Created", "Submitted", "Paid", "Disputed", "Refunded"];

function shorten(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sameAddress(a, b) {
  return a?.toLowerCase() === b?.toLowerCase();
}

function statusClass(status) {
  return `status ${String(status || "").toLowerCase()}`;
}

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [contractAddress, setContractAddress] = useState(deployed.contractAddress || "");
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [contractInfo, setContractInfo] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [message, setMessage] = useState("Connect MetaMask and load contract data.");
  const [loading, setLoading] = useState(false);

  const role = useMemo(() => {
    if (!account || !contractInfo) return "Not connected";
    if (sameAddress(account, contractInfo.client)) return "Client";
    if (sameAddress(account, contractInfo.freelancer)) return "Freelancer";
    if (contractInfo.approvers?.some((a) => sameAddress(a, account))) return "Approver";
    return "Unauthorized";
  }, [account, contractInfo]);

  const currentApproverMilestones = useMemo(() => {
    if (!account || role !== "Approver") return { pending: [], approved: [], disputedByMe: [] };
    return {
      pending: milestones.filter((m) => m.status === "Submitted" && !m.approvedByCurrentAccount),
      approved: milestones.filter((m) => m.approvedByCurrentAccount),
      disputedByMe: milestones.filter((m) => m.latestDispute?.exists && sameAddress(m.latestDispute.raisedBy, account))
    };
  }, [account, role, milestones]);

  const freelancerDisputes = useMemo(() => {
    return milestones.filter((m) => m.status === "Disputed" && m.latestDispute?.exists);
  }, [milestones]);

  async function getProviderAndSigner() {
    if (!window.ethereum) {
      throw new Error("MetaMask not found. Please install MetaMask first.");
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    return { provider, signer };
  }

  async function getContract(useSigner = false) {
    if (!ethers.isAddress(contractAddress)) {
      throw new Error("Invalid contract address. Deploy first or paste the correct address.");
    }
    const { provider, signer } = await getProviderAndSigner();
    return new ethers.Contract(contractAddress, ESCROW_ABI, useSigner ? signer : provider);
  }

  async function connectWallet() {
    try {
      setLoading(true);
      const { provider, signer } = await getProviderAndSigner();
      const network = await provider.getNetwork();
      setAccount(await signer.getAddress());
      setChainId(network.chainId.toString());
      setMessage("Wallet connected. Now refresh contract data.");
      await refreshData();
    } catch (err) {
      setMessage(err.shortMessage || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshData() {
    try {
      setLoading(true);
      const { provider, signer } = await getProviderAndSigner();
      const network = await provider.getNetwork();
      const currentAccount = await signer.getAddress();
      setAccount(currentAccount);
      setChainId(network.chainId.toString());

      const contract = new ethers.Contract(contractAddress, ESCROW_ABI, provider);
      const [client, freelancer, threshold, approvers, balance, count] = await Promise.all([
        contract.client(),
        contract.freelancer(),
        contract.approvalThreshold(),
        contract.getApprovers(),
        contract.getContractBalance(),
        contract.getMilestoneCount()
      ]);

      const loaded = [];
      for (let i = 0; i < Number(count); i++) {
        const [m, approved, latestDispute] = await Promise.all([
          contract.getMilestone(i),
          contract.hasApprovedCurrentSubmission(i, currentAccount),
          contract.getLatestDispute(i)
        ]);

        loaded.push({
          id: i,
          description: m.description,
          amountWei: m.amount,
          amount: ethers.formatEther(m.amount),
          proofURI: m.proofURI,
          freelancerResponse: m.freelancerResponse,
          approvalCount: Number(m.approvalCount),
          submissionVersion: Number(m.submissionVersion),
          status: STATUS_LABELS[Number(m.status)] || "Unknown",
          approvedByCurrentAccount: approved,
          latestDispute: {
            exists: latestDispute.exists,
            raisedBy: latestDispute.raisedBy,
            reason: latestDispute.reason,
            freelancerResponse: latestDispute.freelancerResponse,
            resolved: latestDispute.resolved,
            timestamp: Number(latestDispute.timestamp)
          }
        });
      }

      setContractInfo({
        client,
        freelancer,
        approvers,
        threshold: Number(threshold),
        balance: ethers.formatEther(balance)
      });
      setMilestones(loaded);
      setMessage("Contract data loaded successfully.");
    } catch (err) {
      setMessage(err.shortMessage || err.reason || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runTransaction(actionLabel, txFunction) {
    try {
      setLoading(true);
      setMessage(`${actionLabel}. Confirm the transaction in MetaMask...`);
      const tx = await txFunction();
      await tx.wait();
      setMessage(`${actionLabel} completed.`);
      await refreshData();
    } catch (err) {
      setMessage(err.shortMessage || err.reason || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitMilestone(milestoneId, proofURI) {
    await runTransaction("Submitting milestone", async () => {
      const contract = await getContract(true);
      return contract.submitMilestone(BigInt(milestoneId), proofURI);
    });
  }

  async function approveMilestone(milestoneId) {
    await runTransaction("Approving milestone", async () => {
      const contract = await getContract(true);
      return contract.approveMilestone(BigInt(milestoneId));
    });
  }

  async function raiseDispute(milestoneId, reason) {
    await runTransaction("Raising dispute", async () => {
      const contract = await getContract(true);
      return contract.raiseDispute(BigInt(milestoneId), reason);
    });
  }

  async function respondToDispute(milestoneId, response) {
    await runTransaction("Sending dispute response", async () => {
      const contract = await getContract(true);
      return contract.respondToDispute(BigInt(milestoneId), response);
    });
  }

  async function resubmitMilestone(milestoneId, proofURI, response) {
    await runTransaction("Resubmitting milestone", async () => {
      const contract = await getContract(true);
      return contract.resubmitMilestone(BigInt(milestoneId), proofURI, response);
    });
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Ethereum Smart Contract Application</p>
          <h1>SmartEscrow</h1>
          <p>Milestone-based escrow with freelancer submission, multi-party approval, dispute messages, and resubmission.</p>
        </div>
        <button onClick={connectWallet} disabled={loading}>
          {account ? `Connected: ${shorten(account)}` : "Connect MetaMask"}
        </button>
      </header>

      <section className="panel connection-panel">
        <div className="input-row">
          <label>Contract Address</label>
          <input value={contractAddress} onChange={(e) => setContractAddress(e.target.value.trim())} />
          <button onClick={refreshData} disabled={loading}>Refresh</button>
        </div>
        <div className="notice-bar">
          <span className={loading ? "spinner" : "dot"}></span>
          <span>{loading ? "Working..." : message}</span>
        </div>
      </section>

      <nav className="tabs">
        <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>Dashboard</button>
        <button className={page === "freelancer" ? "active" : ""} onClick={() => setPage("freelancer")}>Freelancer Page</button>
        <button className={page === "approver" ? "active" : ""} onClick={() => setPage("approver")}>Approver Page</button>
      </nav>

      {page === "dashboard" && (
        <DashboardPage
          account={account}
          chainId={chainId}
          role={role}
          contractInfo={contractInfo}
          milestones={milestones}
        />
      )}

      {page === "freelancer" && (
        <FreelancerPage
          account={account}
          role={role}
          contractInfo={contractInfo}
          milestones={milestones}
          disputes={freelancerDisputes}
          onSubmit={submitMilestone}
          onRespond={respondToDispute}
          onResubmit={resubmitMilestone}
          loading={loading}
        />
      )}

      {page === "approver" && (
        <ApproverPage
          account={account}
          role={role}
          contractInfo={contractInfo}
          milestones={milestones}
          pending={currentApproverMilestones.pending}
          approved={currentApproverMilestones.approved}
          disputedByMe={currentApproverMilestones.disputedByMe}
          onApprove={approveMilestone}
          onDispute={raiseDispute}
          loading={loading}
        />
      )}
    </div>
  );
}

function DashboardPage({ account, chainId, role, contractInfo, milestones }) {
  return (
    <main className="page-grid">
      <section className="panel">
        <h2>Wallet and Role</h2>
        <p><strong>Connected account:</strong> {account || "Not connected"}</p>
        <p><strong>Network chain ID:</strong> {chainId || "-"}</p>
        <p><strong>Your role:</strong> <span className="pill">{role}</span></p>
        <p className={chainId === "31337" ? "ok" : "warning"}>
          {chainId === "31337" ? "Connected to Hardhat Local." : "For local demo, switch MetaMask to Hardhat Local chain ID 31337."}
        </p>
      </section>

      <section className="panel">
        <h2>Contract Summary</h2>
        <p><strong>Client:</strong> {shorten(contractInfo?.client)}</p>
        <p><strong>Freelancer:</strong> {shorten(contractInfo?.freelancer)}</p>
        <p><strong>Threshold:</strong> {contractInfo?.threshold || "-"} approvals</p>
        <p><strong>Locked balance:</strong> {contractInfo?.balance || "-"} ETH</p>
        <p><strong>Approvers:</strong></p>
        <ul>
          {contractInfo?.approvers?.map((a) => <li key={a}>{shorten(a)}</li>) || <li>-</li>}
        </ul>
      </section>

      <section className="panel full-width">
        <h2>Milestone Status Board</h2>
        <MilestoneCards milestones={milestones} threshold={contractInfo?.threshold} />
      </section>
    </main>
  );
}

function FreelancerPage({ role, contractInfo, milestones, disputes, onSubmit, onRespond, onResubmit, loading }) {
  const [selectedMilestone, setSelectedMilestone] = useState("0");
  const [proofURI, setProofURI] = useState("https://github.com/demo/project/commit/abc123");
  const [responseMilestone, setResponseMilestone] = useState("0");
  const [response, setResponse] = useState("I reviewed the issue and will submit an updated version.");
  const [newProofURI, setNewProofURI] = useState("https://github.com/demo/project/commit/fixed456");

  return (
    <main className="page-grid">
      <section className="panel full-width">
        <h2>Freelancer Page</h2>
        <p>This page is for submitting completed milestone work, viewing approval progress, and responding to disputes.</p>
        {role !== "Freelancer" && <p className="warning">Switch MetaMask to the Freelancer account to submit or resubmit work.</p>}
      </section>

      <section className="panel">
        <h3>Submit New Milestone</h3>
        <label>Milestone</label>
        <select value={selectedMilestone} onChange={(e) => setSelectedMilestone(e.target.value)}>
          {milestones.map((m) => <option key={m.id} value={m.id}>#{m.id} - {m.description} ({m.status})</option>)}
        </select>
        <label>Proof link / URI</label>
        <input value={proofURI} onChange={(e) => setProofURI(e.target.value)} />
        <button disabled={loading || role !== "Freelancer"} onClick={() => onSubmit(selectedMilestone, proofURI)}>
          Submit Milestone
        </button>
        <p className="hint">Only milestones in Created status can be submitted here. Disputed milestones use resubmission below.</p>
      </section>

      <section className="panel">
        <h3>Approval Progress</h3>
        {milestones.map((m) => (
          <div className="mini-card" key={m.id}>
            <strong>#{m.id} {m.description}</strong>
            <p><span className={statusClass(m.status)}>{m.status}</span></p>
            <p>Approvals: {m.approvalCount} / {contractInfo?.threshold || "-"}</p>
            <p>Proof: {m.proofURI || "Not submitted"}</p>
          </div>
        ))}
      </section>

      <section className="panel full-width">
        <h3>Dispute Notifications</h3>
        {disputes.length === 0 ? (
          <p className="ok">No active disputes for the freelancer.</p>
        ) : (
          disputes.map((m) => (
            <div className="notification dispute" key={m.id}>
              <h4>Milestone #{m.id}: {m.description}</h4>
              <p><strong>Disputed by:</strong> {shorten(m.latestDispute.raisedBy)}</p>
              <p><strong>Problem found:</strong> {m.latestDispute.reason}</p>
              <p><strong>Your response:</strong> {m.latestDispute.freelancerResponse || "No response yet"}</p>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h3>Respond to Dispute</h3>
        <label>Milestone</label>
        <select value={responseMilestone} onChange={(e) => setResponseMilestone(e.target.value)}>
          {milestones.map((m) => <option key={m.id} value={m.id}>#{m.id} - {m.description} ({m.status})</option>)}
        </select>
        <label>Response message</label>
        <textarea value={response} onChange={(e) => setResponse(e.target.value)} />
        <button disabled={loading || role !== "Freelancer"} onClick={() => onRespond(responseMilestone, response)}>
          Send Response Only
        </button>
      </section>

      <section className="panel">
        <h3>Resubmit Updated Work</h3>
        <label>Milestone</label>
        <select value={responseMilestone} onChange={(e) => setResponseMilestone(e.target.value)}>
          {milestones.map((m) => <option key={m.id} value={m.id}>#{m.id} - {m.description} ({m.status})</option>)}
        </select>
        <label>New proof link / URI</label>
        <input value={newProofURI} onChange={(e) => setNewProofURI(e.target.value)} />
        <label>Response / changes made</label>
        <textarea value={response} onChange={(e) => setResponse(e.target.value)} />
        <button disabled={loading || role !== "Freelancer"} onClick={() => onResubmit(responseMilestone, newProofURI, response)}>
          Resubmit Work
        </button>
        <p className="hint">Resubmission moves the milestone back to Submitted and resets approvals for the new version.</p>
      </section>
    </main>
  );
}

function ApproverPage({ role, contractInfo, milestones, pending, approved, disputedByMe, onApprove, onDispute, loading }) {
  const [selectedMilestone, setSelectedMilestone] = useState("0");
  const [reason, setReason] = useState("The submitted work is incomplete. Please fix the missing deliverable and resubmit.");

  return (
    <main className="page-grid">
      <section className="panel full-width">
        <h2>Approver Page</h2>
        <p>This page shows review notifications for submitted milestones. Approvers can approve or raise a dispute with a message.</p>
        {role !== "Approver" && <p className="warning">Switch MetaMask to Approver 1, Approver 2, or Approver 3 to approve/dispute.</p>}
      </section>

      <section className="panel full-width">
        <h3>Review Notifications</h3>
        {pending.length === 0 ? (
          <p className="ok">No pending milestone submissions for this approver.</p>
        ) : (
          pending.map((m) => (
            <div className="notification" key={m.id}>
              <h4>New submission: Milestone #{m.id} - {m.description}</h4>
              <p><strong>Proof:</strong> {m.proofURI}</p>
              <p><strong>Approvals so far:</strong> {m.approvalCount} / {contractInfo?.threshold || "-"}</p>
              <p className="hint">This notification will disappear for you after you approve this current submission.</p>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h3>Approve a Milestone</h3>
        <label>Milestone</label>
        <select value={selectedMilestone} onChange={(e) => setSelectedMilestone(e.target.value)}>
          {milestones.map((m) => <option key={m.id} value={m.id}>#{m.id} - {m.description} ({m.status})</option>)}
        </select>
        <button disabled={loading || role !== "Approver"} onClick={() => onApprove(selectedMilestone)}>
          Approve Milestone
        </button>
      </section>

      <section className="panel">
        <h3>Raise a Dispute</h3>
        <label>Milestone</label>
        <select value={selectedMilestone} onChange={(e) => setSelectedMilestone(e.target.value)}>
          {milestones.map((m) => <option key={m.id} value={m.id}>#{m.id} - {m.description} ({m.status})</option>)}
        </select>
        <label>What problem did you find?</label>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="danger" disabled={loading || role !== "Approver"} onClick={() => onDispute(selectedMilestone, reason)}>
          Raise Dispute
        </button>
      </section>

      <section className="panel full-width">
        <h3>Your Review History</h3>
        {approved.length === 0 && disputedByMe.length === 0 ? (
          <p>No approvals or disputes from this account yet.</p>
        ) : (
          <div className="history-grid">
            {approved.map((m) => (
              <div className="notification success" key={`a-${m.id}`}>
                You approved milestone #{m.id}: {m.description}. {m.status === "Paid" ? "Payment has been released." : "Waiting for more approvals."}
              </div>
            ))}
            {disputedByMe.map((m) => (
              <div className="notification dispute" key={`d-${m.id}`}>
                <strong>You raised a dispute for milestone #{m.id}: {m.description}</strong>
                <p>{m.latestDispute.reason}</p>
                <p><strong>Freelancer response:</strong> {m.latestDispute.freelancerResponse || "No response yet"}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function MilestoneCards({ milestones, threshold }) {
  if (!milestones.length) return <p>No milestone data loaded yet.</p>;
  return (
    <div className="milestone-grid">
      {milestones.map((m) => (
        <div className="milestone-card" key={m.id}>
          <div className="milestone-header">
            <h3>#{m.id}: {m.description}</h3>
            <span className={statusClass(m.status)}>{m.status}</span>
          </div>
          <p><strong>Amount:</strong> {m.amount} ETH</p>
          <p><strong>Version:</strong> {m.submissionVersion}</p>
          <p><strong>Approvals:</strong> {m.approvalCount} / {threshold || "-"}</p>
          <p><strong>Proof:</strong> {m.proofURI || "Not submitted"}</p>
          {m.latestDispute?.exists && (
            <div className="small-dispute">
              <strong>Latest dispute:</strong> {m.latestDispute.reason}
              <br />
              <strong>Freelancer response:</strong> {m.latestDispute.freelancerResponse || "None yet"}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
