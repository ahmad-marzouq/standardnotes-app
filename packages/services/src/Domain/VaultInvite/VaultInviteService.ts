import { AcceptVaultInvite } from './UseCase/AcceptVaultInvite'
import { SyncEvent, SyncEventReceivedSharedVaultInvitesData } from './../Event/SyncEvent'
import { InternalEventInterface } from './../Internal/InternalEventInterface'
import { InternalEventHandlerInterface } from './../Internal/InternalEventHandlerInterface'
import { ItemManagerInterface } from './../Item/ItemManagerInterface'
import { FindContact } from './../Contacts/UseCase/FindContact'
import { GetUntrustedPayload } from './../AsymmetricMessage/UseCase/GetUntrustedPayload'
import { GetTrustedPayload } from './../AsymmetricMessage/UseCase/GetTrustedPayload'
import { InviteRecord } from './InviteRecord'
import { VaultUserServiceInterface } from './../VaultUser/VaultUserServiceInterface'
import { GetVault } from '../Vault/UseCase/GetVault'
import { InviteToVault } from './UseCase/InviteToVault'
import { GetVaultContacts } from '../VaultUser/UseCase/GetVaultContacts'
import { SyncServiceInterface } from './../Sync/SyncServiceInterface'
import { InternalEventBusInterface } from './../Internal/InternalEventBusInterface'
import { SessionsClientInterface } from './../Session/SessionsClientInterface'
import { GetAllContacts } from './../Contacts/UseCase/GetAllContacts'
import {
  AsymmetricMessageSharedVaultInvite,
  PayloadEmitSource,
  SharedVaultListingInterface,
  TrustedContactInterface,
} from '@standardnotes/models'
import { VaultInviteServiceInterface } from './VaultInviteServiceInterface'
import {
  ClientDisplayableError,
  SharedVaultInviteServerHash,
  SharedVaultUserServerHash,
  isClientDisplayableError,
  isErrorResponse,
} from '@standardnotes/responses'
import { AbstractService } from './../Service/AbstractService'
import { VaultInviteServiceEvent } from './VaultInviteServiceEvent'
import { ContentType, Result } from '@standardnotes/domain-core'
import { SharedVaultInvitesServer } from '@standardnotes/api'
import { GetKeyPairs } from '../Encryption/UseCase/GetKeyPairs'
import { DecryptErroredPayloads } from '../Encryption/UseCase/DecryptErroredPayloads'

export class VaultInviteService
  extends AbstractService<VaultInviteServiceEvent>
  implements VaultInviteServiceInterface, InternalEventHandlerInterface
{
  private pendingInvites: Record<string, InviteRecord> = {}

  constructor(
    items: ItemManagerInterface,
    private session: SessionsClientInterface,
    private vaultUsers: VaultUserServiceInterface,
    private sync: SyncServiceInterface,
    private invitesServer: SharedVaultInvitesServer,
    private _getAllContacts: GetAllContacts,
    private _getVault: GetVault,
    private _getVaultContacts: GetVaultContacts,
    private _inviteToVault: InviteToVault,
    private _getTrustedPayload: GetTrustedPayload,
    private _getUntrustedPayload: GetUntrustedPayload,
    private _findContact: FindContact,
    private _acceptVaultInvite: AcceptVaultInvite,
    private _getKeyPairs: GetKeyPairs,
    private _decryptErroredPayloads: DecryptErroredPayloads,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    this.eventDisposers.push(
      items.addObserver<TrustedContactInterface>(ContentType.TYPES.TrustedContact, async ({ inserted, source }) => {
        if (source === PayloadEmitSource.LocalChanged && inserted.length > 0) {
          void this.downloadInboundInvites()
        }

        await this.reprocessCachedInvitesTrustStatusAfterTrustedContactsChange()
      }),
    )
  }

  override deinit(): void {
    super.deinit()
    ;(this.session as unknown) = undefined
    ;(this.vaultUsers as unknown) = undefined
    ;(this.sync as unknown) = undefined
    ;(this.invitesServer as unknown) = undefined
    ;(this._getAllContacts as unknown) = undefined
    ;(this._getVault as unknown) = undefined
    ;(this._getVaultContacts as unknown) = undefined
    ;(this._inviteToVault as unknown) = undefined
    ;(this._getTrustedPayload as unknown) = undefined
    ;(this._getUntrustedPayload as unknown) = undefined
    ;(this._findContact as unknown) = undefined
    ;(this._acceptVaultInvite as unknown) = undefined
    ;(this._getKeyPairs as unknown) = undefined
    ;(this._decryptErroredPayloads as unknown) = undefined

    this.pendingInvites = {}
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case SyncEvent.ReceivedSharedVaultInvites:
        await this.processInboundInvites(event.payload as SyncEventReceivedSharedVaultInvitesData)
        break
    }
  }

  public getCachedPendingInviteRecords(): InviteRecord[] {
    return Object.values(this.pendingInvites)
  }

  public async downloadInboundInvites(): Promise<ClientDisplayableError | SharedVaultInviteServerHash[]> {
    const response = await this.invitesServer.getInboundUserInvites()

    if (isErrorResponse(response)) {
      return ClientDisplayableError.FromString(`Failed to get inbound user invites ${JSON.stringify(response)}`)
    }

    this.pendingInvites = {}

    await this.processInboundInvites(response.data.invites)

    return response.data.invites
  }

  public async getOutboundInvites(
    sharedVault?: SharedVaultListingInterface,
  ): Promise<SharedVaultInviteServerHash[] | ClientDisplayableError> {
    const response = await this.invitesServer.getOutboundUserInvites()

    if (isErrorResponse(response)) {
      return ClientDisplayableError.FromString(`Failed to get outbound user invites ${JSON.stringify(response)}`)
    }

    if (sharedVault) {
      return response.data.invites.filter((invite) => invite.shared_vault_uuid === sharedVault.sharing.sharedVaultUuid)
    }

    return response.data.invites
  }

  public async acceptInvite(pendingInvite: InviteRecord): Promise<void> {
    if (!pendingInvite.trusted) {
      throw new Error('Cannot accept untrusted invite')
    }

    await this._acceptVaultInvite.execute({ invite: pendingInvite.invite, message: pendingInvite.message })

    delete this.pendingInvites[pendingInvite.invite.uuid]

    void this.sync.sync()

    await this._decryptErroredPayloads.execute()

    await this.sync.syncSharedVaultsFromScratch([pendingInvite.invite.shared_vault_uuid])
  }

  public async getInvitableContactsForSharedVault(
    sharedVault: SharedVaultListingInterface,
  ): Promise<TrustedContactInterface[]> {
    const users = await this.vaultUsers.getSharedVaultUsers(sharedVault)
    if (!users) {
      return []
    }

    const contacts = this._getAllContacts.execute()
    if (contacts.isFailed()) {
      return []
    }

    const outboundInvites = await this.getOutboundInvites(sharedVault)
    if (isClientDisplayableError(outboundInvites)) {
      return []
    }

    return contacts.getValue().filter((contact) => {
      const isContactAlreadyInVault = users.some((user) => user.user_uuid === contact.contactUuid)
      const isContactAlreadyInvited = outboundInvites.some((invite) => invite.user_uuid === contact.contactUuid)
      return !isContactAlreadyInVault && !isContactAlreadyInvited
    })
  }

  public async inviteContactToSharedVault(
    sharedVault: SharedVaultListingInterface,
    contact: TrustedContactInterface,
    permission: string,
  ): Promise<Result<SharedVaultInviteServerHash>> {
    const contactsResult = await this._getVaultContacts.execute({
      sharedVaultUuid: sharedVault.sharing.sharedVaultUuid,
      readFromCache: false,
    })
    if (contactsResult.isFailed()) {
      return Result.fail(contactsResult.getError())
    }

    const contacts = contactsResult.getValue()

    const result = await this._inviteToVault.execute({
      sharedVault,
      recipient: contact,
      sharedVaultContacts: contacts,
      permission,
    })
    if (result.isFailed()) {
      return Result.fail(result.getError())
    }

    void this.notifyEvent(VaultInviteServiceEvent.InviteSent)

    await this.sync.sync()

    return result
  }

  public isVaultUserOwner(user: SharedVaultUserServerHash): boolean {
    const result = this._getVault.execute<SharedVaultListingInterface>({ sharedVaultUuid: user.shared_vault_uuid })
    if (result.isFailed()) {
      return false
    }

    const vault = result.getValue()
    return vault != undefined && vault.sharing.ownerUserUuid === user.user_uuid
  }

  public async deleteInvite(invite: SharedVaultInviteServerHash): Promise<ClientDisplayableError | void> {
    const response = await this.invitesServer.deleteInvite({
      sharedVaultUuid: invite.shared_vault_uuid,
      inviteUuid: invite.uuid,
    })

    if (isErrorResponse(response)) {
      return ClientDisplayableError.FromString(`Failed to delete invite ${JSON.stringify(response)}`)
    }

    delete this.pendingInvites[invite.uuid]
  }

  private async reprocessCachedInvitesTrustStatusAfterTrustedContactsChange(): Promise<void> {
    const cachedInvites = this.getCachedPendingInviteRecords().map((record) => record.invite)

    await this.processInboundInvites(cachedInvites)
  }

  private async processInboundInvites(invites: SharedVaultInviteServerHash[]): Promise<void> {
    if (invites.length === 0) {
      return
    }

    const keys = this._getKeyPairs.execute()
    if (keys.isFailed()) {
      return
    }

    for (const invite of invites) {
      delete this.pendingInvites[invite.uuid]

      const sender = this._findContact.execute({ userUuid: invite.sender_uuid })
      if (!sender.isFailed()) {
        const trustedMessage = this._getTrustedPayload.execute<AsymmetricMessageSharedVaultInvite>({
          message: invite,
          privateKey: keys.getValue().encryption.privateKey,
          ownUserUuid: this.session.userUuid,
          sender: sender.getValue(),
        })

        if (!trustedMessage.isFailed()) {
          this.pendingInvites[invite.uuid] = {
            invite,
            message: trustedMessage.getValue(),
            trusted: true,
          }

          continue
        }
      }

      const untrustedMessage = this._getUntrustedPayload.execute<AsymmetricMessageSharedVaultInvite>({
        message: invite,
        privateKey: keys.getValue().encryption.privateKey,
      })

      if (!untrustedMessage.isFailed()) {
        this.pendingInvites[invite.uuid] = {
          invite,
          message: untrustedMessage.getValue(),
          trusted: false,
        }
      }
    }

    void this.notifyEvent(VaultInviteServiceEvent.InvitesReloaded)
  }
}
