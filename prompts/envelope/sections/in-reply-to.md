{% if envelope.inReplyTo %}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
{% if envelope.inReplyTo.attachmentsText != "(none)" %}
in-reply-to-attachments:
{{ envelope.inReplyTo.attachmentsText }}
{% endif %}
{% endif %}
