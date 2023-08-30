import { firebaseApp, firebaseAuth, getCeremonyCircuits, getCircuitBySequencePosition, getCircuitContributionsFromContributor, getCurrentActiveParticipantTimeout, getDocumentById, getLatestUpdatesFromParticipant } from "./firebase";
import { Contribution, FirebaseDocumentInfo, ParticipantContributionStep, ParticipantStatus } from "./interfaces";
import { getAuth, GithubAuthProvider, signInWithPopup, signOut } from  "firebase/auth"
import { DocumentData, DocumentSnapshot, onSnapshot } from "firebase/firestore";
import { checkParticipantForCeremony, permanentlyStoreCurrentContributionTimeAndHash, progressToNextCircuitForContribution, progressToNextContributionStep, resumeContributionAfterTimeoutExpiration, verifyContribution } from "./functions";
import { checkGitHubReputation, convertToDoubleDigits, downloadCeremonyArtifact, formatHash, formatZkeyIndex, generatePublicAttestation, getBucketName, getGithubProviderUserId, getParticipantsCollectionPath, getSecondsMinutesHoursFromMillis, getZkeyStorageFilePath, handleTweetGeneration, multiPartUpload, publishGist, sleep } from "./utils";
import { bucketPostfix, commonTerms } from "./constants";
import randomf from "randomf"

declare global {
    interface Window {
      snarkjs: any;
    }
  }
  
const snarkjs = window.snarkjs;

// the zKey generated by snarkjs
const nextZKey: any = { type: "mem" }

/**
 * Signs in the user using GitHub OAuth2 and Firebase
 * @returns 
 */
export const signInWithGitHub = async (): Promise<string> => {
    const provider = new GithubAuthProvider()
    // gist scope
    provider.addScope("gist")
    try {
        const result = await signInWithPopup(firebaseAuth, provider)
        const credentials = GithubAuthProvider.credentialFromResult(result)
        const token = credentials?.accessToken
        const user = result.user

        localStorage.setItem("token", token!.toString())
        localStorage.setItem("username", user.displayName!)

        return user.displayName!
    } catch (error: any) {
        console.log(error)
        return ""
    }
}

/**
 * Signs out the user from Firebase
 * @param setUser 
 */
export const signOutWithGitHub = async () => {
    const auth = getAuth(firebaseApp)
    try {
        await signOut(auth)
        localStorage.removeItem("token")
        localStorage.removeItem("username")
    } catch (error: any) {
        console.error(error)
    }
}

/**
 * Allow a user to contribute using definitely setup
 * @param ceremonyId {string}
 * @param setStatus {function}
 * @returns 
 */
export const contribute = async (ceremonyId: string, setStatus: (message: string, loading?: boolean, attestationLink?: string) => void) => {
    const user = getAuth(firebaseApp).currentUser
    if (user === null) {
        setStatus("Not authenticated, please authenticate first")
        return 
    }

    const token = localStorage.getItem("token")
    if (!token) {
        setStatus("No token, auth first")
        return 
    }

    // check if the user passes the GitHub reputation checks
    const reputable = await checkGitHubReputation()
    if (!reputable) {
        setStatus(`You do not pass the GitHub reputation checks. 
        You need to have at least: ${import.meta.env.VITE_GITHUB_REPOS} public 
        repo${import.meta.env.VITE_GITHUB_REPOS > 1 ? "s" : ""}, ${import.meta.env.VITE_GITHUB_FOLLOWERS} 
        follower${import.meta.env.VITE_GITHUB_FOLLOWERS > 1 ? "s" : ""}, 
        and follow ${import.meta.env.VITE_GITHUB_FOLLOWING} user${import.meta.env.VITE_GITHUB_FOLLOWING > 1 ? "s" : ""}. 
        Please fulfil the requirements and login again.`)
        return 
    }

    // we are sure to get this cause the user is authenticated
    const participantProviderId = await getGithubProviderUserId(token)

    try {
        setStatus("Checking if you can contribute to the ceremony", true)
        const canParticipateToCeremony = await checkParticipantForCeremony(ceremonyId)

        if (!canParticipateToCeremony) {
            const activeTimeouts = await getCurrentActiveParticipantTimeout(ceremonyId, user.uid)
            if (activeTimeouts.length > 0) {
                // Get active timeout.
                const activeTimeout = activeTimeouts[0]!

                if (!activeTimeout.data) {
                    setStatus("There seems to be an error with the timeout, please try again or contact an administrator", false)
                    return 
                }

                // Extract data.
                const { endDate } = activeTimeout.data!

                const { seconds, minutes, hours, days } = getSecondsMinutesHoursFromMillis(
                    Number(endDate) - Date.now()
                )

                setStatus(`You are timed out. Timeout will end in ${convertToDoubleDigits(days)}:${convertToDoubleDigits(hours)}:${convertToDoubleDigits(
                    minutes
                )}:${convertToDoubleDigits(seconds)} (dd:hh:mm:ss)`, false)
                return 
            } else {
                // check if the user already contributed, or is timed out
                setStatus("You cannot participate to this ceremony", false)
                return 
            }
        }

        setStatus("You can participate to this ceremony", false)

        const participant = await getDocumentById(`ceremonies/${ceremonyId}/participants`, user.uid)
        await listenToParticipantDocumentChanges(participant, ceremonyId, participantProviderId!, token, setStatus)
    } catch (error: any) {
        setStatus(error)
    }

}

/**
 * Starts or resumes a contribution
 * @param ceremonyId 
 * @param circuit 
 * @param participant 
 * @param contributorIdentifier 
 * @returns 
 */
export const handleStartOrResumeContribution = async (
    ceremonyId: string,
    circuit: FirebaseDocumentInfo,
    participant: FirebaseDocumentInfo,
    contributorIdentifier: string,
    setStatus: (message: string, loading?: boolean, attestationLink?: string) => void
) => {
    const ceremony = await getDocumentById("ceremonies", ceremonyId)
    const ceremonyData = ceremony.data()

    if (!ceremonyData) {
        setStatus("There is no such ceremony", false)
        return 
    }
    const { prefix: ceremonyPrefix } = ceremonyData

    const { waitingQueue, prefix: circuitPrefix, sequencePosition } = circuit.data
    const { completedContributions } = waitingQueue // = current progress.

    const updatedParticipant = await getDocumentById(`ceremonies/${ceremonyId}/participants`, participant.id)
    if (!updatedParticipant.data()) {
        setStatus("The participant document seems to not have any data, please try again.", false)
        return 
    } 

    setStatus(`You are contributing at circuit #${sequencePosition}`, true)

    let updatedParticipantData = updatedParticipant.data()!

    const lastZkeyIndex = formatZkeyIndex(completedContributions)
    const nextZkeyIndex = formatZkeyIndex(completedContributions + 1)

    const lastZkeyCompleteFilename = `${circuitPrefix}_${lastZkeyIndex}.zkey`
    const nextZkeyCompleteFilename = `${circuitPrefix}_${nextZkeyIndex}.zkey`

    // Prepare zKey storage paths.
    const lastZkeyStorageFilePath = getZkeyStorageFilePath(circuitPrefix, lastZkeyCompleteFilename)
    const nextZkeyStorageFilePath = getZkeyStorageFilePath(circuitPrefix, nextZkeyCompleteFilename)

    // Get ceremony bucket name.
    const bucketName = getBucketName(ceremonyPrefix, bucketPostfix)

    let blob: Uint8Array = new Uint8Array()
    if (updatedParticipantData.contributionStep === ParticipantContributionStep.DOWNLOADING) {
        setStatus("Downloading zKey", true)
        blob = await downloadCeremonyArtifact(bucketName, lastZkeyStorageFilePath, setStatus)

        setStatus("Downloaded zKey", false)
        // progress to the next step
        await progressToNextContributionStep(ceremonyId)

        await sleep(10000)

        updatedParticipantData = await getLatestUpdatesFromParticipant(ceremonyId, participant.id)
    }

    if (updatedParticipantData.contributionStep === ParticipantContributionStep.COMPUTING) {
        setStatus("Computing contribution", true)

        // time
        const start = new Date().getTime();
        let output: any 
        // contribute
        try {
            output = await snarkjs.zKey.contribute(
                blob,
                nextZKey,
                contributorIdentifier,
                Array(32)
                .fill(null)
                .map(() => randomf(2n ** 256n))
                .join(''),
            )
        } catch (error: any) {
            setStatus(`Error computing, ${error.toString()}`, false)
            
        }

        // take hash
        const hash = formatHash(output, "Contribution Hash: ")

        const end = new Date().getTime();
        const time = end - start;
        setStatus(`Computed zKey in: ${time}ms`, false);

        // upload hash and time taken
        await permanentlyStoreCurrentContributionTimeAndHash(
            ceremony.id,
            time,
            hash
        )

        await sleep(5000)

        await progressToNextContributionStep(ceremony.id)
        await sleep(1000)

        // Refresh most up-to-date data from the participant document.
        updatedParticipantData = await getLatestUpdatesFromParticipant(ceremony.id, participant.id)

    }

    if (updatedParticipantData.contributionStep === ParticipantContributionStep.UPLOADING) {
        setStatus("Uploading contribution", true)
        await multiPartUpload(
            bucketName,
            nextZkeyStorageFilePath,
            nextZKey.data,
            setStatus,
            ceremony.id,
            updatedParticipantData.tempContributionData
        )

        setStatus("Uploaded contribution", false)
        await sleep(1000)

        await progressToNextContributionStep(ceremonyId)
        await sleep(1000)

        // Refresh most up-to-date data from the participant document.
        updatedParticipantData = await getLatestUpdatesFromParticipant(ceremonyId, participant.id)
    }

    if (updatedParticipantData.contributionStep === ParticipantContributionStep.VERIFYING) {
        setStatus("Verifying contribution", true)
        try {
            // Execute contribution verification.
            await verifyContribution(
                ceremony.id,
                circuit,
                bucketName,
                contributorIdentifier,
                String(import.meta.env.VITE_FIREBASE_CF_URL_VERIFY_CONTRIBUTION)
            )
            setStatus("Contribution is valid", false)
        } catch (error: any) {
            setStatus(`Error verifying, ${error.toString()}`, false)
        }
    }

}

/**
 * Listen to circuit document changes.
 * @notice the circuit is the one for which the participant wants to contribute.
 * @dev display custom messages in order to make the participant able to follow what's going while waiting in the queue.
 * Also, this listener use another listener for the current circuit contributor in order to inform the waiting participant about the current contributor's progress.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param participantId <string> - the unique identifier of the participant.
 * @param circuit <FirebaseDocumentInfo> - the Firestore document info about the circuit.
 */
export const listenToCeremonyCircuitDocumentChanges = (
    ceremonyId: string,
    participantId: string,
    circuit: FirebaseDocumentInfo,
    setStatus: (message: string, loading?: boolean) => void
) => {
    let cachedLatestPosition = 0

    const unsubscribeToCeremonyCircuitListener = onSnapshot(circuit.ref, async (changedCircuit: DocumentSnapshot) => {
        // Check data.
        if (!circuit.data || !changedCircuit.data()) {
            setStatus(`There is no circuit data for circuit ${circuit.id}`, false)
            return 
        }

        // Extract data.
        const { avgTimings, waitingQueue } = changedCircuit.data()!
        const { currentContributor } = waitingQueue
        const { fullContribution, verifyCloudFunction } = avgTimings

        const circuitCurrentContributor = await getDocumentById(
            getParticipantsCollectionPath(ceremonyId),
            currentContributor
        )

        // Check data.
        if (!circuitCurrentContributor.data()) {
            setStatus("No circuit current contributor data. Please try again")
            return 
        }

        const latestParticipantPositionInQueue = waitingQueue.contributors.indexOf(participantId) + 1

        const newEstimatedWaitingTime =
        fullContribution <= 0 && verifyCloudFunction <= 0
            ? 0
            : (fullContribution + verifyCloudFunction) * (latestParticipantPositionInQueue - 1)
        const { seconds, minutes, hours, days } = getSecondsMinutesHoursFromMillis(newEstimatedWaitingTime)

        // Check if the participant is now the new current contributor for the circuit.
        if (latestParticipantPositionInQueue === 1) {
            setStatus(`You are now the first in the queue, getting ready for contributing.`, true)
            // Unsubscribe from updates.
            unsubscribeToCeremonyCircuitListener()
            // eslint-disable no-unused-vars
        } else if (latestParticipantPositionInQueue !== cachedLatestPosition) {
            setStatus(`You are at position ${latestParticipantPositionInQueue} in the queue`, false)
            setStatus(
                `You will have to wait for ${latestParticipantPositionInQueue - 1} contributors (~${
                newEstimatedWaitingTime > 0
                    ? 
                          `${convertToDoubleDigits(days)}:${convertToDoubleDigits(hours)}:${convertToDoubleDigits(minutes)}:${convertToDoubleDigits(seconds)}`
                    : `no time`
            } (dd/hh/mm/ss))`, false)

            cachedLatestPosition = latestParticipantPositionInQueue
        }
    })
}

/**
 * Generate a public attestation for a contributor, publish the attestation as gist, and prepare a new ready-to-share tweet about ceremony participation.
 * @param circuits <Array<FirebaseDocumentInfo>> - the array of ceremony circuits documents.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param participantId <string> - the unique identifier of the contributor.
 * @param participantContributions <Array<Co> - the document data of the participant.
 * @param contributorIdentifier <string> - the identifier of the contributor (handle, name, uid).
 * @param ceremonyName <string> - the name of the ceremony.
 * @param ceremonyPrefix <string> - the prefix of the ceremony.
 * @param participantAccessToken <string> - the access token of the participant.
 */
export const handlePublicAttestation = async (
    circuits: Array<FirebaseDocumentInfo>,
    ceremonyId: string,
    participantId: string,
    participantContributions: Array<Contribution>,
    contributorIdentifier: string,
    ceremonyName: string,
    ceremonyPrefix: string,
    participantAccessToken: string,
    setStatus: (message: string, loading?: boolean, attestationLink?: string) => void
): Promise<string> => {
    // Generate attestation with valid contributions.
    const publicAttestation = await generatePublicAttestation(
        circuits,
        ceremonyId,
        participantId,
        participantContributions,
        contributorIdentifier,
        ceremonyName,
        setStatus
    )

    await sleep(1000) // workaround for file descriptor unexpected close.

    const gistUrl = await publishGist(participantAccessToken, publicAttestation, ceremonyName, ceremonyPrefix)

    // Prepare a ready-to-share tweet.
    const tweetURL = await handleTweetGeneration(ceremonyName, gistUrl)
    return tweetURL
}

/**
 * Main contribution login
 * @param participant {DocumentSnapshot<DocumentData>}
 * @param ceremonyId {string}
 */
export const listenToParticipantDocumentChanges = async (
    participant: DocumentSnapshot<DocumentData>,
    ceremonyId: string,
    participantProviderId: string,
    token: string,
    setStatus: (message: string, loading?: boolean, attestationLink?: string) => void
) => {
    const ceremonyDodc = await getDocumentById(commonTerms.collections.ceremonies.name, ceremonyId)
    const ceremonyData = ceremonyDodc.data()
    if (!ceremonyData) {
        setStatus(`There is no such ceremony`, false)
        return 
    }
    const unsubscribe = onSnapshot(participant.ref, async (changedParticipant: DocumentSnapshot) => {
        // Extract data.
        const {
            contributionProgress: prevContributionProgress,
            status: prevStatus,
            contributions: prevContributions,
            contributionStep: prevContributionStep,
            tempContributionData: prevTempContributionData
        } = participant.data()!

        const {
            contributionProgress: changedContributionProgress,
            status: changedStatus,
            contributionStep: changedContributionStep,
            contributions: changedContributions,
            tempContributionData: changedTempContributionData,
        } = changedParticipant.data()!

        const circuits = await getCeremonyCircuits(ceremonyId)

        if (
            changedStatus === ParticipantStatus.WAITING &&
            !changedContributionStep &&
            !changedContributions.length &&
            !changedContributionProgress
        ) {
            // Progress the participant to the next circuit making it ready for contribution.
            setStatus("Progressing to the next circuit", true)
            await progressToNextCircuitForContribution(ceremonyId)
            await sleep(1000)
        }

        if (changedContributionProgress > 0 && changedContributionProgress <= circuits.length) {
            const circuit = circuits[changedContributionProgress-1]

            if (!circuit.data) return 

            const { waitingQueue } = circuit.data

            // Define pre-conditions for different scenarios.
            const isWaitingForContribution = changedStatus === ParticipantStatus.WAITING

            const isCurrentContributor =
                changedStatus === ParticipantStatus.CONTRIBUTING && waitingQueue.currentContributor === participant.id

            const isResumingContribution =
                changedContributionStep === prevContributionStep &&
                changedContributionProgress === prevContributionProgress

            const noStatusChanges = changedStatus === prevStatus

            const progressToNextContribution = changedContributionStep === ParticipantContributionStep.COMPLETED

            const completedContribution = progressToNextContribution && changedStatus === ParticipantStatus.CONTRIBUTED

            const timeoutTriggeredWhileContributing =
                changedStatus === ParticipantStatus.TIMEDOUT &&
                changedContributionStep !== ParticipantContributionStep.COMPLETED

            const timeoutExpired = changedStatus === ParticipantStatus.EXHUMED

            const alreadyContributedToEveryCeremonyCircuit =
                    changedStatus === ParticipantStatus.DONE &&
                    changedContributionStep === ParticipantContributionStep.COMPLETED &&
                    changedContributionProgress === circuits.length &&
                    changedContributions.length === circuits.length

            const noTemporaryContributionData = !prevTempContributionData && !changedTempContributionData

            const samePermanentContributionData =
                (!prevContributions && !changedContributions) ||
                prevContributions.length === changedContributions.length

            const downloadingStep = changedContributionStep === ParticipantContributionStep.DOWNLOADING
            const computingStep = changedContributionStep === ParticipantContributionStep.COMPUTING
            const uploadingStep = changedContributionStep === ParticipantContributionStep.UPLOADING

            const hasResumableStep = downloadingStep || computingStep || uploadingStep

            const resumingContribution =
                prevContributionStep === changedContributionStep &&
                prevStatus === changedStatus &&
                prevContributionProgress === changedContributionProgress

            const resumingContributionButAdvancedToAnotherStep = prevContributionStep !== changedContributionStep

            const resumingAfterTimeoutExpiration = prevStatus === ParticipantStatus.EXHUMED

            const neverResumedContribution = !prevContributionStep

            const resumingWithSameTemporaryData =
                !!prevTempContributionData &&
                !!changedTempContributionData &&
                JSON.stringify(Object.keys(prevTempContributionData).sort()) ===
                    JSON.stringify(Object.keys(changedTempContributionData).sort()) &&
                JSON.stringify(Object.values(prevTempContributionData).sort()) ===
                    JSON.stringify(Object.values(changedTempContributionData).sort())

            const startingOrResumingContribution =
                // Pre-condition W => contribute / resume when contribution step = DOWNLOADING.
                (isCurrentContributor &&
                    downloadingStep &&
                    (resumingContribution ||
                        resumingContributionButAdvancedToAnotherStep ||
                        resumingAfterTimeoutExpiration ||
                        neverResumedContribution)) ||
                // Pre-condition X => contribute / resume when contribution step = COMPUTING.
                (computingStep && resumingContribution && samePermanentContributionData) ||
                // Pre-condition Y => contribute / resume when contribution step = UPLOADING without any pre-uploaded chunk.
                (uploadingStep && resumingContribution && noTemporaryContributionData) ||
                // Pre-condition Z => contribute / resume when contribution step = UPLOADING w/ some pre-uploaded chunk.
                (!noTemporaryContributionData && resumingWithSameTemporaryData)

            
            if (isCurrentContributor && hasResumableStep && startingOrResumingContribution) {
                setStatus("Starting or resuming contribution", true)
                await handleStartOrResumeContribution(ceremonyId, circuit, changedParticipant, participantProviderId, setStatus)
            } else if (isWaitingForContribution) {
                listenToCeremonyCircuitDocumentChanges(ceremonyId, participant.id, circuit, setStatus)
            }

            if (
                isCurrentContributor &&
                isResumingContribution &&
                changedContributionStep === ParticipantContributionStep.VERIFYING
            ) {
                setStatus("Resuming and verifying", false)
                setStatus("Verifying might have not started if you are in this step. Please wait for a confirmation or timeout", false)
            }

            if (progressToNextContribution && noStatusChanges &&
                (changedStatus === ParticipantStatus.DONE || changedStatus === ParticipantStatus.CONTRIBUTED)) {
                    // get the latest verification result 
                    const res = await getLatestVerificationResult(ceremonyId, circuit.id, participant.id)
                    setStatus(`Result of previous contribution - verified = ${res}`, false)
            }

            // check timeout
            if (timeoutTriggeredWhileContributing) {
                // alert how long
                const activeTimeouts = await getCurrentActiveParticipantTimeout(ceremonyId, participant.id)
                if (activeTimeouts.length !== 1) {
                    setStatus("You are timed out, please reload the page and wait for the timeout to expire", false)
                    unsubscribe()
                }

                // Get active timeout.
                const activeTimeout = activeTimeouts[0]!

                if (!activeTimeout.data) {
                    setStatus("There seems to be an error with the timeout, please reload the page and try again or contact the coordinator", false)
                    unsubscribe()
                }

                // Extract data.
                const { endDate } = activeTimeout.data!

                const { seconds, minutes, hours, days } = getSecondsMinutesHoursFromMillis(
                    Number(endDate) - Date.now()
                )

                setStatus(`You are timed out. Timeout will end in ${convertToDoubleDigits(days)}:${convertToDoubleDigits(hours)}:${convertToDoubleDigits(
                    minutes
                )}:${convertToDoubleDigits(seconds)} (dd:hh:mm:ss)`, false)
            }

            if (completedContribution || timeoutExpired) {
                if (completedContribution) {
                    const res = await getLatestVerificationResult(ceremonyId, circuit.id, participant.id)
                    setStatus(`The latest contribution was verifed as ${res}`, false)
                }

                const nextCircuit = timeoutExpired ? getCircuitBySequencePosition(circuits, changedContributionProgress) : getCircuitBySequencePosition(circuits, changedContributionProgress + 1)
                
                if (!timeoutExpired) {
                    // progress to next circuit
                    setStatus(`Progressing to the next circuit at position #${nextCircuit.data.sequencePosition}`, true)
                    await progressToNextCircuitForContribution(ceremonyId)
                } else {
                    // resume 
                    setStatus(`Resuming with circuit  #${nextCircuit.data.sequencePosition}`, true)
                    await resumeContributionAfterTimeoutExpiration(ceremonyId)
                }
            }

            if (alreadyContributedToEveryCeremonyCircuit) {
                const res = await getLatestVerificationResult(ceremonyId, circuit.id, participant.id)
                setStatus(`The latest contribution was verifed as ${res ? "valid" : "invalid"}`, false)

                // generate public attestation
                setStatus("You have contributed to all circuits", false)

                const url = await handlePublicAttestation(circuits, ceremonyId, participant.id, changedContributions, participantProviderId, ceremonyData.title, ceremonyData.prefix, token, setStatus)
                setStatus(`You can share your attestation by clicking the button below`, false, url)
                unsubscribe()
            }
        }
    })
}

/**
 * Get the latest verification result from Firestore
 * @param ceremonyId 
 * @param circuitId 
 * @param participantId 
 * @returns 
 */
export const getLatestVerificationResult = async (ceremonyId: string, circuitId: string, participantId: string): Promise<boolean> => {
    const circuitContributionsFromContributor = await getCircuitContributionsFromContributor(ceremonyId, circuitId, participantId)

    const contribution = circuitContributionsFromContributor[0]

    return contribution?.data.valid 
}
