<#-- ADR-0026: the email code fallback. One field per page; the same page whether or not a code was sent. -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>
  <#if section = "header">
    ${msg("endoEmailTitle")}
  <#elseif section = "form">
    <form id="kc-endo-email-code" action="${url.loginAction}" method="post">
      <#if stage == "code">
        <p>${msg("endoEmailSent")}</p>
        <label for="code">${msg("endoEmailCode")}</label>
        <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
               autocomplete="one-time-code" required autofocus>
        <input type="hidden" name="stage" value="code">
      <#else>
        <label for="address">${msg("endoEmailAddress")}</label>
        <input id="address" name="address" type="email" autocomplete="email" maxlength="254" required autofocus>
        <input type="hidden" name="stage" value="address">
      </#if>
      <button type="submit">${msg("doSubmit")}</button>
    </form>
  </#if>
</@layout.registrationLayout>
