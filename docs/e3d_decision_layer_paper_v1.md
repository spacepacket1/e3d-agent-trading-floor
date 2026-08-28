# The E3D Decision Layer

## From On-Chain Theses to Actions, Outcomes, and Learning

### Abstract

Most blockchain analytics systems stop at observation. They expose transactions, wallets, token transfers, price charts, liquidity pools, and alerts, but they rarely close the loop between a detected signal and a measurable result. The first E3D methodology paper introduced an on-chain intelligence framework that transforms raw blockchain activity into structured **Stories** and then into higher-order **Theses**. This paper extends that framework by introducing the **E3D Decision Layer**: a modular system that converts validated Theses into risk-scored Actions, evaluates Outcomes across defined horizons, and uses those Outcomes to improve future decision quality.

The Decision Layer does not require E3D to become a trading platform or custody user funds. Instead, it provides a testable bridge between intelligence and action. It can recommend, simulate, score, and evaluate decisions such as watching a token, investigating a wallet cluster, avoiding a risky asset, identifying an accumulation signal, or producing a paper-trading action. By measuring what happens after each Action, E3D turns on-chain interpretation into empirical intelligence.

In short:

> **Stories explain what happened. Theses explain what it might mean. Actions define what to do about it. Outcomes prove whether the intelligence was useful. Learning improves the system over time.**

## 1. Introduction

Blockchain data is abundant, public, and continuously updated. Every transaction, transfer, swap, approval, liquidity movement, contract interaction, and wallet relationship is observable. Yet most systems present this data as dashboards, charts, tables, or alerts. The user is still responsible for converting raw observations into interpretation, interpretation into decisions, and decisions into measured outcomes.

This creates a gap between **visibility** and **intelligence**.

A dashboard can show that a wallet moved funds. An alert can show that liquidity changed. A chart can show that price moved. But these are not yet intelligence. Intelligence requires structure, context, interpretation, decision logic, and feedback.

The first E3D methodology paper defined a framework for transforming raw on-chain structure into human-readable Stories and higher-order Theses. That framework can be summarized as:

$$\text{Transactions} \rightarrow \text{Stories} \rightarrow \text{Theses}$$

This paper extends that sequence:

$$\text{Transactions} \rightarrow \text{Stories} \rightarrow \text{Theses} \rightarrow \text{Actions} \rightarrow \text{Outcomes} \rightarrow \text{Learning}$$

The central claim of this paper is simple:

> **On-chain intelligence becomes truly valuable only when it can be converted into testable decisions and measured against real outcomes.**

The Decision Layer is E3D's framework for doing exactly that.

## 2. Foundation: Stories and Theses

The OTA methodology establishes how E3D converts raw on-chain activity into structured intelligence.

At the lowest level, E3D observes blockchain state and activity as a time-indexed structure:

$$G_{t} = \left( V_{t},E_{t} \right)$$

where:

-   $G_{t}$ is the on-chain graph at time $t$,
-   $V_{t}$ represents entities such as addresses, contracts, tokens, pools, and wallets,
-   $E_{t}$ represents relationships such as transfers, swaps, approvals, liquidity movements, and contract interactions.

From this raw graph, E3D generates Stories:

$$S_{t} = f_{S}\left( G_{t},E_{t},M_{t} \right)$$

where:

-   $S_{t}$ is a Story at time $t$,
-   $G_{t}$ is the observed graph structure,
-   $E_{t}$ is supporting evidence,
-   $M_{t}$ is market context,
-   $f_{S}$ is the Story-generation function.

A Story is an interpretable description of something meaningful happening on-chain.

Multiple related Stories can then be combined into a Thesis:

$$\Theta_{t} = f_{\Theta}\left( \{ S_{i}\}_{i = 1}^{n},\Omega_{t} \right)$$

where:

-   $\Theta_{t}$ is a Thesis,
-   $\{ S_{i}\}_{i = 1}^{n}$ is a set of related Stories,
-   $\Omega_{t}$ is contextual overlap across addresses, tokens, contracts, venues, motifs, and time windows,
-   $f_{\Theta}$ is the Thesis-generation function.

A Thesis is a higher-order interpretation formed when multiple Stories point toward the same underlying structure.

The OTA framework therefore transforms the blockchain from a flat transaction record into a structured intelligence stream.

But a Thesis still leaves one question unanswered:

> **What should be done with this information?**

That question belongs to the Decision Layer.

## 3. The Decision Layer

The E3D Decision Layer converts validated Theses into risk-scored Actions and then measures what happened after those Actions.

The Decision Layer is not limited to trading. An Action can represent any structured response to a Thesis.

Examples include:

-   **Watch** a token, pool, wallet, or contract.
-   **Investigate** a suspicious cluster of addresses.
-   **Avoid** a token because risk signals are rising.
-   **Accumulate Signal** when structural evidence suggests improving conditions.
-   **Reduce Exposure Signal** when liquidity, distribution, or risk deteriorates.
-   **Confirm Risk** when multiple independent warning signals converge.
-   **Request More Evidence** when the Thesis is promising but incomplete.
-   **Paper Trade** when the system simulates a hypothetical entry or exit.
-   **Agent Action** when an autonomous or semi-autonomous agent records a recommended decision.

This distinction is important. E3D does not need to execute trades to become actionable. The first version of the Decision Layer can operate entirely as a decision intelligence, paper-action, and outcome-measurement system.

The goal is not merely to say:

> "Something interesting happened."

The goal is to say:

> "Something interesting happened, here is the Thesis, here is the recommended Action, here is the risk, here is the expected horizon, and here is how we will know whether the Thesis was useful."

## 4. Action Function

An Action is generated from a Thesis, adjusted by risk, confidence, user objective, and time horizon.

$$A_{t} = f_{A}\left( \Theta_{t},R_{t},C_{t},U_{t},H_{t} \right)$$

where:

-   $A_{t}$ is the Action generated at time $t$,
-   $\Theta_{t}$ is the underlying Thesis,
-   $R_{t}$ is the estimated risk,
-   $C_{t}$ is the confidence score,
-   $U_{t}$ is the user or agent objective,
-   $H_{t}$ is the expected time horizon,
-   $f_{A}$ is the Action-generation function.

In plain English:

> **E3D does not act on a Thesis alone. It acts only after adjusting for risk, confidence, objective, and time horizon.**

This prevents the system from treating all Theses equally. A strong Thesis with high risk may produce a Watch action rather than an Accumulate Signal. A moderate Thesis with low risk and clear confirmation criteria may produce a Paper Trade. A suspicious Thesis with rising contract or liquidity risk may produce an Avoid action.

A practical Action record can include:

-   action type,
-   linked Thesis,
-   linked Stories,
-   target token, pool, contract, or wallet,
-   confidence score,
-   risk score,
-   expected horizon,
-   trigger reason,
-   supporting evidence,
-   model version,
-   agent version,
-   current status.

This turns subjective interpretation into a structured decision object.

## 5. Action Score

To rank possible Actions, E3D can compute an Action Score.

$$Q_{A}(t) = \alpha C_{t} + \beta I_{t} + \gamma K_{t} - \delta R_{t} - \lambda D_{t}$$

where:

-   $Q_{A}(t)$ is the Action Score,
-   $C_{t}$ is confidence,
-   $I_{t}$ is expected impact,
-   $K_{t}$ is confirmation strength,
-   $R_{t}$ is risk,
-   $D_{t}$ is uncertainty or data weakness,
-   $\alpha,\beta,\gamma,\delta,\lambda$ are weighting parameters.

In plain English:

> **An Action becomes more attractive when confidence, impact, and confirmation are high, and less attractive when risk or uncertainty is high.**

This score can be used to rank Actions in the UI, filter weak Actions, or route stronger Actions to agents.

For example:

-   High $Q_{A}(t)$ may produce an Accumulate Signal.
-   Medium $Q_{A}(t)$ may produce a Watch action.
-   Low $Q_{A}(t)$ may produce Request More Evidence.
-   Negative $Q_{A}(t)$ may produce Avoid or Confirm Risk.

The Action Score is not a guarantee. It is a disciplined way to convert a Thesis into a decision recommendation that can later be tested.

## 6. Outcome Function

Every Action should eventually be evaluated.

An Outcome measures what happened after the Action across a defined time horizon.

$$O_{t + h} = f_{O}\left( A_{t},P_{t + h},L_{t + h},V_{t + h},N_{t + h},D_{t + h} \right)$$

where:

-   $O_{t + h}$ is the measured Outcome after horizon $h$,
-   $A_{t}$ is the original Action,
-   $P_{t + h}$ is price behavior,
-   $L_{t + h}$ is liquidity behavior,
-   $V_{t + h}$ is volume behavior,
-   $N_{t + h}$ is network or holder behavior,
-   $D_{t + h}$ is drawdown, volatility, or downside risk,
-   $f_{O}$ is the Outcome-evaluation function.

In plain English:

> **Every Action gets graded later by what actually happened on-chain and in the market.**

Possible Outcome metrics include:

-   price return,
-   volume change,
-   liquidity change,
-   holder growth or decline,
-   transfer velocity,
-   whale accumulation or distribution,
-   maximum drawdown,
-   volatility expansion,
-   rug or exploit indicators,
-   Thesis confirmation,
-   time-to-confirmation,
-   outcome score.

This gives E3D a feedback mechanism that most analytics systems do not have.

## 7. Outcome Score

A simple Outcome Score can compare expected results against observed results.

$$Q_{O}(t + h) = \mu R_{P} + \nu R_{L} + \xi R_{V} + \rho R_{N} - \sigma MDD - \kappa X$$

where:

-   $Q_{O}(t + h)$ is the Outcome Score after horizon $h$,
-   $R_{P}$ is price return,
-   $R_{L}$ is liquidity improvement,
-   $R_{V}$ is volume improvement,
-   $R_{N}$ is network or holder improvement,
-   $MDD$ is maximum drawdown,
-   $X$ is realized risk, exploit risk, or invalidation penalty,
-   $\mu,\nu,\xi,\rho,\sigma,\kappa$ are weighting parameters.

In plain English:

> **An Outcome is better when price, liquidity, volume, and network behavior improve, and worse when drawdown or realized risk is high.**

Different Action types should have different Outcome criteria.

For example, an Accumulate Signal may care about price return, liquidity expansion, and holder growth. An Avoid action may be considered successful if the token later declines, liquidity drains, volatility spikes, or contract risk materializes. An Investigate action may be successful if it reveals a meaningful wallet cluster, exploit pattern, insider structure, or false positive.

This means E3D can evaluate not only bullish actions, but also defensive, investigative, and risk-reduction actions.

## 8. Thesis Confirmation

A Thesis is confirmed when the expected pattern appears in subsequent data.

Let ${\widehat{O}}_{t + h}$ represent the expected Outcome implied by the Thesis and Action. Let $O_{t + h}$ represent the observed Outcome.

The confirmation score can be represented as:

$$\Phi_{t + h} = 1 - d\left( {\widehat{O}}_{t + h},O_{t + h} \right)$$

where:

-   $\Phi_{t + h}$ is the confirmation score,
-   ${\widehat{O}}_{t + h}$ is the expected Outcome,
-   $O_{t + h}$ is the observed Outcome,
-   $d( \cdot )$ is a distance or error function.

In plain English:

> **A Thesis is stronger when reality behaves the way the Thesis expected.**

If $\Phi_{t + h}$ is high, the Thesis was confirmed. If $\Phi_{t + h}$ is low, the Thesis was weak, early, incomplete, or wrong.

This allows E3D to build a historical record of which Thesis types, Story patterns, graph structures, and agent decisions actually worked.

## 9. Learning Loop

The final layer is learning.

E3D can update future signal weights by comparing expected Outcomes to actual Outcomes.

$$W_{t + 1} = W_{t} + \eta\nabla\mathcal{L}\left( O_{t + h},{\widehat{O}}_{t + h} \right)$$

where:

-   $W_{t}$ is the current set of model or signal weights,
-   $W_{t + 1}$ is the updated set of weights,
-   $\eta$ is the learning rate,
-   $\mathcal{L}$ is a loss function,
-   $O_{t + h}$ is the observed Outcome,
-   ${\widehat{O}}_{t + h}$ is the expected Outcome,
-   $\nabla\mathcal{L}$ is the gradient or adjustment direction.

In plain English:

> **If the system expected one result and reality produced another, E3D adjusts the future importance of the signals that led to that decision.**

This does not require fully autonomous machine learning in the first implementation. The initial system can begin with simple statistical tracking:

-   Which Story types led to successful Theses?
-   Which Thesis types led to successful Actions?
-   Which risk factors predicted failure?
-   Which signals were early but useful?
-   Which signals created false positives?
-   Which time horizons produced the best confirmation?

Over time, these measurements can become training data for more advanced scoring models.

## 10. The Complete E3D Intelligence Loop

The full E3D intelligence loop can now be described as:

$$G_{t} \rightarrow S_{t} \rightarrow \Theta_{t} \rightarrow A_{t} \rightarrow O_{t + h} \rightarrow W_{t + 1}$$

where:

-   $G_{t}$ is the on-chain graph,
-   $S_{t}$ is a Story,
-   $\Theta_{t}$ is a Thesis,
-   $A_{t}$ is an Action,
-   $O_{t + h}$ is the Outcome after time horizon $h$,
-   $W_{t + 1}$ is the updated signal weighting.

In plain English:

> **E3D observes the blockchain, explains what is happening, forms a Thesis, recommends an Action, measures the result, and improves future decisions.**

This transforms E3D from a blockchain explorer into a closed-loop on-chain intelligence system.

## 11. Implementation Architecture

The Decision Layer can be implemented without merging all systems into a single monolithic application.

A practical architecture is:

$$\text{E3D Core} \rightarrow \text{Action Engine} \rightarrow \text{Outcome Engine} \rightarrow \text{E3D UI}$$

### 11.1 E3D Core

E3D Core continues to perform the foundational work:

-   mine blockchain data,
-   build graph structures,
-   detect patterns,
-   generate Stories,
-   generate Theses,
-   write intelligence objects to ClickHouse.

### 11.2 Action Engine

The Action Engine can remain physically separate from the E3D application while writing structured Action records into shared ClickHouse tables.

Its responsibilities include:

-   read Stories and Theses,
-   score possible Actions,
-   generate recommendations,
-   assign confidence and risk,
-   define expected horizons,
-   store supporting evidence,
-   record model and agent versions.

### 11.3 Outcome Engine

The Outcome Engine evaluates Actions after their expected horizon expires.

Its responsibilities include:

-   read open Actions,
-   calculate post-Action market and on-chain metrics,
-   compare expected and actual Outcomes,
-   assign Outcome Scores,
-   mark Actions as confirmed, failed, expired, or inconclusive,
-   write evaluation results to ClickHouse.

### 11.4 E3D UI

The E3D UI displays the full intelligence chain:

$$\text{Story} \rightarrow \text{Thesis} \rightarrow \text{Action} \rightarrow \text{Outcome}$$

This gives users a transparent view of why an Action was suggested and whether it worked.

## 12. Suggested Data Model

The first version can be implemented with three core tables.

### 12.1 `E3DActions`

Each row represents one recommended or simulated Action.

    actionId
    chain
    thesisId
    storyIds
    tokenAddress
    tokenSymbol
    actionType
    confidence
    riskScore
    expectedHorizon
    entryContext
    triggerReason
    evidenceJson
    createdAt
    modelVersion
    agentVersion
    status

Possible `actionType` values:

    watch
    investigate
    accumulate_signal
    reduce_exposure_signal
    avoid
    confirm_risk
    request_more_evidence
    paper_buy
    paper_sell
    paper_hold

Possible `status` values:

    open
    evaluating
    evaluated
    expired
    inconclusive

### 12.2 `E3DOutcomes`

Each row evaluates one Action after a defined horizon.

    outcomeId
    actionId
    thesisId
    tokenAddress
    evaluationWindow
    priceReturn
    volumeChange
    liquidityChange
    holderChange
    transferVelocityChange
    maxDrawdown
    volatilityChange
    thesisConfirmed
    outcomeScore
    notes
    evaluatedAt

### 12.3 `E3DLearningSignals`

This table is optional in the first implementation, but useful as the system matures.

    signalId
    actionId
    thesisId
    featureName
    featureWeightBefore
    featureWeightAfter
    predictionError
    learningAdjustment
    createdAt

These tables allow the trading app, agent framework, or Action Engine to remain separate while E3D becomes the visualization and intelligence layer.

## 13. User Interface Concepts

The Decision Layer should make Actions and Outcomes visible without making E3D feel like a broker or trading platform.

### 13.1 Actions View

An Actions View could show:

-   token,
-   linked Thesis,
-   recommended Action,
-   confidence,
-   risk,
-   horizon,
-   trigger reason,
-   supporting evidence,
-   current status.

Example:

    Action: Watch / Possible Accumulation Setup
    Confidence: 74%
    Risk: Medium
    Horizon: 24–72 hours
    Reason: Wallet clustering, liquidity expansion, and rising transfer velocity converged across three Stories.

### 13.2 Outcomes View

An Outcomes View could show:

-   original Action,
-   expected Outcome,
-   actual Outcome,
-   price return,
-   liquidity change,
-   volume change,
-   holder change,
-   maximum drawdown,
-   Thesis confirmation,
-   Outcome Score.

Example:

    Outcome: Confirmed
    Price: +18.4%
    Volume: +63.0%
    Liquidity: +11.0%
    Holders: +4.2%
    Evaluation Window: 48 hours

### 13.3 Thesis Scorecard

Each Thesis can have a scorecard showing all Actions derived from it and their measured results.

This creates a transparent audit trail:

$$\text{Thesis} \rightarrow \{ A_{1},A_{2},...,A_{n}\} \rightarrow \{ O_{1},O_{2},...,O_{n}\}$$

In plain English:

> **Every Thesis can be judged by the Actions it produced and the Outcomes those Actions achieved.**

## 14. Why This Matters

The Decision Layer gives E3D several advantages.

### 14.1 It Makes Intelligence Testable

A Story can be interesting. A Thesis can be compelling. But an Action with a measured Outcome can be tested.

This is the shift from narrative analytics to empirical intelligence.

### 14.2 It Creates a Performance Record

Once E3D records Actions and Outcomes over time, it can build a historical performance record:

-   Which Thesis types worked?
-   Which tokens responded to structural signals?
-   Which agent versions performed best?
-   Which signals were noisy?
-   Which risk factors mattered most?

This record can become valuable to hedge funds, analysts, institutions, token teams, and autonomous agents.

### 14.3 It Avoids Premature Regulatory Complexity

The first Decision Layer does not need custody, order execution, or brokerage functionality. It can produce paper actions, research actions, risk warnings, and outcome analysis.

This allows E3D to demonstrate value before becoming a trading system.

### 14.4 It Supports Autonomous Agents

Agents need more than data. They need objectives, decision rules, risk limits, memory, and feedback.

The Decision Layer provides the missing bridge:

$$\text{Thesis} + \text{Risk} + \text{Objective} \rightarrow \text{Action} \rightarrow \text{Outcome} \rightarrow \text{Learning}$$

This creates a natural foundation for future E3D agents.

## 15. Example Walkthrough

Consider a token that begins showing unusual on-chain behavior.

### Step 1: Stories

E3D detects three Stories:

1.  A cluster of wallets begins accumulating the token.
2.  Liquidity increases across a major pool.
3.  Transfer velocity rises without a corresponding price move.

### Step 2: Thesis

E3D combines the Stories into a Thesis:

> **The token may be entering an accumulation phase before broader market recognition.**

### Step 3: Action

The Action Engine produces:

    Action: Watch / Accumulation Signal
    Confidence: 76%
    Risk: Medium
    Horizon: 48 hours
    Trigger: Wallet clustering + liquidity expansion + transfer velocity increase

Mathematically:

$$A_{t} = f_{A}\left( \Theta_{t},R_{t},C_{t},U_{t},H_{t} \right)$$

### Step 4: Outcome

After 48 hours, the Outcome Engine measures:

    Price Return: +14.2%
    Volume Change: +51.0%
    Liquidity Change: +8.5%
    Holder Change: +3.1%
    Max Drawdown: -4.8%
    Thesis Confirmed: true

### Step 5: Learning

E3D records that this combination of Story patterns produced a confirmed Outcome. Over time, similar pattern combinations may receive higher confidence weights.

## 16. Future Work

The Decision Layer opens several paths for future development.

### 16.1 Paper Trading and Simulation

E3D can simulate Actions before executing real trades. This allows the system to measure performance without capital risk.

### 16.2 Agent-Specific Objectives

Different agents may have different goals:

-   capital preservation,
-   momentum capture,
-   anomaly detection,
-   risk avoidance,
-   token community growth,
-   liquidity monitoring,
-   long-term accumulation.

The Action Function can incorporate these objectives through $U_{t}$.

### 16.3 Cross-Chain Expansion

The same Decision Layer can eventually support multiple chains.

For each chain $c$, the graph can be represented as:

$$G_{t}^{(c)} = \left( V_{t}^{(c)},E_{t}^{(c)} \right)$$

and the combined multi-chain intelligence loop becomes:

$$\{ G_{t}^{(c)}\}_{c = 1}^{m} \rightarrow \{ S_{t}^{(c)}\} \rightarrow \{\Theta_{t}^{(c)}\} \rightarrow \{ A_{t}^{(c)}\} \rightarrow \{ O_{t + h}^{(c)}\}$$

This allows E3D to compare signals across Ethereum, Solana, Bitcoin-adjacent systems, and other networks over time.

### 16.4 Institutional Signal Feeds

Once Actions and Outcomes are tracked, E3D can expose intelligence through APIs:

-   Thesis feed,
-   Action feed,
-   Outcome feed,
-   risk feed,
-   agent feed,
-   historical performance feed.

This creates a path toward institutional research products.

### 16.5 Strategy Benchmarking

E3D can compare Decision Layer performance against baselines:

$$\Delta_{E3D} = \text{Score}\left( \text{Price} + \text{E3D Signals} \right) - \text{Score}\left( \text{Price Only} \right)$$

In plain English:

> **Delta E3D measures whether E3D adds useful information beyond price alone.**

This is one of the most important long-term validation metrics for the entire system.

## 17. Conclusion

The first E3D methodology paper introduced a framework for transforming blockchain activity into Stories and Theses. This paper extends that framework by introducing the E3D Decision Layer: a system for converting Theses into Actions, Actions into Outcomes, and Outcomes into Learning.

The result is a closed-loop model of on-chain intelligence:

$$\text{Observe} \rightarrow \text{Interpret} \rightarrow \text{Hypothesize} \rightarrow \text{Act} \rightarrow \text{Measure} \rightarrow \text{Learn}$$

or, in the E3D stack:

$$\text{Transactions} \rightarrow \text{Stories} \rightarrow \text{Theses} \rightarrow \text{Actions} \rightarrow \text{Outcomes} \rightarrow \text{Learning}$$

This is the critical step that moves E3D beyond dashboards, alerts, and explanations.

E3D becomes a system for producing testable intelligence.

The core thesis of this paper is therefore:

> **The value of on-chain intelligence is not merely in detecting patterns, but in converting those patterns into decisions, measuring their outcomes, and improving the system through feedback.**

That is the foundation of the E3D Decision Layer.

## Live Implementation

The E3D Decision Layer is now live. Agent verdicts and outcomes produced by the E3D Agent Verdict Engine are visible at [/agent-verdicts](/agent-verdicts).
