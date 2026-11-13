<?php
/** Per-request durable fence, kept outside the portal webroot and auth storage.
 *
 * UUID lookup alone cannot resolve a crash between native Add and its UUID
 * receipt. Under this process-lifetime lock, a pre-Add checkpoint makes that
 * gap terminally ambiguous instead of permitting a second native Add. A known
 * message ID or native UUID may still reconcile it without another write.
 */
final class HubBitrixSendFence
{
    private $lock;
    private string $file;
    private string $digest;
    private ?array $record;

    public function __construct(string $directory, string $uuid, string $digest)
    {
        if (!preg_match('/^[a-f0-9-]{36}$/D', $uuid)) throw new RuntimeException('request_id_conflict');
        if (is_link($directory) || (!is_dir($directory) && !@mkdir($directory, 0700, true))) {
            throw new RuntimeException('portal_recovery_storage_unavailable');
        }
        @chmod($directory, 0700);
        $this->file = $directory . '/' . $uuid . '.json';
        $lockFile = $directory . '/' . $uuid . '.lock';
        if (is_link($this->file) || is_link($lockFile)) throw new RuntimeException('portal_recovery_storage_unavailable');
        $this->lock = @fopen($lockFile, 'c+');
        if (!$this->lock || !flock($this->lock, LOCK_EX)) throw new RuntimeException('portal_recovery_storage_unavailable');
        @chmod($lockFile, 0600);
        $this->digest = $digest;
        $this->record = null;
        if (is_file($this->file)) {
            // A malformed/truncated checkpoint is NOT evidence of no prior Add.
            // Distinguish an absent journal from JSON null and corrupted states.
            try { $record = json_decode(file_get_contents($this->file), true, 16, JSON_THROW_ON_ERROR); }
            catch (Throwable $error) { throw new RuntimeException('portal_send_ambiguous'); }
            if (!is_array($record) || !is_string($record['digest'] ?? null)
                || !in_array($record['stage'] ?? null, ['submitting', 'created'], true)
                || ($record['stage'] === 'created' && (!is_int($record['messageId'] ?? null) || $record['messageId'] < 1))) {
                throw new RuntimeException('portal_send_ambiguous');
            }
            $this->record = $record;
        }
        if ($this->record !== null && $this->record['digest'] !== $digest) throw new RuntimeException('request_id_conflict');
    }

    /** A created ID remains evidence even when a later UUID read is missing. */
    public function messageId(): ?int { return isset($this->record['messageId']) ? (int)$this->record['messageId'] : null; }

    /** Never retry a prior Add whose outcome is not independently observable. */
    public function beforeSubmit(): void
    {
        if ($this->record !== null) throw new RuntimeException('portal_send_ambiguous');
        $this->save(['digest' => $this->digest, 'stage' => 'submitting']);
    }

    public function created(int $id): void
    {
        if ($id < 1) throw new RuntimeException('portal_send_ambiguous');
        $this->save(['digest' => $this->digest, 'stage' => 'created', 'messageId' => $id]);
    }

    /** Atomic replacement plus fsync precedes the native side effect. */
    private function save(array $value): void
    {
        $temp = $this->file . '.' . bin2hex(random_bytes(8));
        $out = @fopen($temp, 'x');
        if (!$out) throw new RuntimeException('portal_recovery_storage_unavailable');
        try {
            chmod($temp, 0600);
            $body = json_encode($value, JSON_THROW_ON_ERROR);
            if (fwrite($out, $body) !== strlen($body) || !fflush($out) || !fsync($out)) throw new RuntimeException('portal_recovery_storage_unavailable');
            if (!rename($temp, $this->file)) throw new RuntimeException('portal_recovery_storage_unavailable');
            $this->record = $value;
        } finally {
            fclose($out);
            if (is_file($temp)) unlink($temp);
        }
    }

    public function __destruct()
    {
        if (is_resource($this->lock)) { flock($this->lock, LOCK_UN); fclose($this->lock); }
    }
}
